import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Db } from '../../shared/database/db.service';
import { Clock } from '../../shared/jobs/clock';
import { JobScheduler } from '../../shared/jobs/job-scheduler';
import { addDays, localDateOf, wallClockToUtc } from '../../shared/time';

export const JOB_NOTIFICATION_DELIVER = 'notification.deliver';
export const JOB_NOTIFICATION_ESCALATE = 'notification.escalate';
export const JOB_NOTIFY_DISPATCH_OFFER = 'notification.dispatch_offer';

export type Channel = 'push' | 'sms' | 'email';
export type Priority = 'critical_ack' | 'high' | 'normal' | 'digest';

export type ProviderResult = 'ok' | 'invalid_token' | 'failed';

/** Adapter seam: FCM/APNs/SMS/SMTP in production, fakes in tests. */
export interface ChannelProvider {
  send(input: {
    channel: Channel;
    contactId: string;
    deviceToken?: string;
    payload: unknown;
  }): Promise<ProviderResult>;
}

class AlwaysOkProvider implements ChannelProvider {
  async send(): Promise<ProviderResult> {
    return 'ok';
  }
}

@Injectable()
export class ProviderRegistry {
  private readonly providers = new Map<Channel, ChannelProvider>();
  private readonly fallback = new AlwaysOkProvider();

  bind(channel: Channel, provider: ChannelProvider): void {
    this.providers.set(channel, provider);
  }

  get(channel: Channel): ChannelProvider {
    return this.providers.get(channel) ?? this.fallback;
  }
}

interface ChainStep {
  channel: Channel;
  timerSeconds: number;
}

/** Fallback chains per priority (runbook §1: tunable via flags later). */
const CHAINS: Record<Priority, ChainStep[]> = {
  critical_ack: [
    { channel: 'push', timerSeconds: 90 },
    { channel: 'sms', timerSeconds: 120 },
    { channel: 'email', timerSeconds: 300 },
  ],
  high: [{ channel: 'push', timerSeconds: 0 }],
  normal: [{ channel: 'push', timerSeconds: 0 }],
  digest: [{ channel: 'email', timerSeconds: 0 }],
};

const QUIET_START_HOUR = 22;
const QUIET_END_HOUR = 8;

@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly providers: ProviderRegistry,
    @Optional() private readonly jobs?: JobScheduler,
  ) {}

  // ── Device registry ────────────────────────────────────────────────

  async registerDevice(
    contactId: string,
    installId: string,
    input: {
      push_token?: string | null;
      platform: 'ios' | 'android' | 'web';
      app_version?: string;
      locale?: string;
      os_permission_state?: string;
    },
  ): Promise<void> {
    await this.db.kysely
      .insertInto('core.device')
      .values({
        contact_id: contactId,
        install_id: installId,
        push_token: input.push_token ?? null,
        platform: input.platform,
        app_version: input.app_version ?? null,
        locale: input.locale ?? null,
        os_permission_state: input.os_permission_state ?? null,
        last_seen_at: this.clock.now(),
      })
      .onConflict((oc) =>
        oc.column('install_id').doUpdateSet({
          contact_id: contactId,
          push_token: input.push_token ?? null,
          platform: input.platform,
          app_version: input.app_version ?? null,
          locale: input.locale ?? null,
          os_permission_state: input.os_permission_state ?? null,
          last_seen_at: this.clock.now(),
          state: 'active',
        }),
      )
      .execute();
  }

  async removeDevice(contactId: string, installId: string): Promise<void> {
    await this.db.kysely
      .deleteFrom('core.device')
      .where('install_id', '=', installId)
      .where('contact_id', '=', contactId)
      .execute();
  }

  // ── Sending ────────────────────────────────────────────────────────

  /**
   * Create and start a notification. Marketing respects per-channel
   * opt-outs; non-urgent categories respect quiet hours in the
   * RECIPIENT's timezone; critical_ack ignores both and requires a
   * client ACK — silence walks the fallback chain.
   */
  async send(params: {
    contactId: string;
    category: 'transactional' | 'marketing';
    priority: Priority;
    kind: string;
    payload: Record<string, unknown>;
  }): Promise<string> {
    const chain = await this.effectiveChain(params);
    const notification = await this.db.tx(async (ctx) => {
      const row = await ctx.trx
        .insertInto('core.notification')
        .values({
          contact_id: params.contactId,
          category: params.category,
          priority: params.priority,
          kind: params.kind,
          payload: JSON.stringify(params.payload),
          state: chain.length === 0 ? 'exhausted' : 'pending',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row;
    });
    if (chain.length === 0) return notification.id; // everything opted out

    const respectsQuietHours =
      params.priority === 'normal' ||
      params.priority === 'digest' ||
      params.category === 'marketing';
    if (respectsQuietHours) {
      const deferUntil = await this.quietHoursDeferral(params.contactId);
      if (deferUntil) {
        await this.jobs?.schedule(
          JOB_NOTIFICATION_DELIVER,
          { notificationId: notification.id, step: 0 },
          deferUntil,
          { dedupeId: `notif_deliver:${notification.id}` },
        );
        return notification.id;
      }
    }

    await this.deliverStep(notification.id, 0);
    return notification.id;
  }

  /** One step of the chain: try devices/channel, arm the ACK timer. */
  async deliverStep(notificationId: string, step: number): Promise<void> {
    const notification = await this.db.kysely
      .selectFrom('core.notification')
      .selectAll()
      .where('id', '=', notificationId)
      .executeTakeFirst();
    if (!notification || notification.acknowledged_at !== null) return;
    if (!['pending', 'delivering'].includes(notification.state)) return;

    const chain = await this.effectiveChain({
      contactId: notification.contact_id,
      category: notification.category as 'transactional' | 'marketing',
      priority: notification.priority as Priority,
    });
    const chainStep = chain[step];
    if (!chainStep) {
      await this.exhaust(notificationId);
      return;
    }

    const now = this.clock.now();
    await this.db.kysely
      .updateTable('core.notification')
      .set({ state: 'delivering' })
      .where('id', '=', notificationId)
      .execute();

    let delivered = false;
    if (chainStep.channel === 'push') {
      const devices = await this.db.kysely
        .selectFrom('core.device')
        .select(['id', 'push_token'])
        .where('contact_id', '=', notification.contact_id)
        .where('state', '=', 'active')
        .where('push_token', 'is not', null)
        .orderBy('last_seen_at', 'desc')
        .execute();
      for (const device of devices) {
        const result = await this.attempt(notificationId, step, 'push', {
          contactId: notification.contact_id,
          deviceId: device.id,
          deviceToken: device.push_token!,
          payload: notification.payload,
        });
        if (result === 'invalid_token') {
          // Provider says the token is dead: prune and try the next device.
          await this.db.kysely
            .updateTable('core.device')
            .set({ state: 'pruned' })
            .where('id', '=', device.id)
            .execute();
          continue;
        }
        if (result === 'ok') {
          delivered = true;
          break;
        }
      }
    } else {
      const result = await this.attempt(notificationId, step, chainStep.channel, {
        contactId: notification.contact_id,
        payload: notification.payload,
      });
      delivered = result === 'ok';
    }

    const requiresAck = notification.priority === 'critical_ack';
    if (!delivered) {
      // Channel unusable (no devices, dead tokens, provider failure):
      // escalate IMMEDIATELY — never wait a timer on a channel that
      // provably went nowhere.
      await this.advance(notificationId, step);
      return;
    }
    if (requiresAck) {
      const escalateAt = new Date(now.getTime() + chainStep.timerSeconds * 1000);
      await this.db.kysely
        .updateTable('core.delivery_attempt')
        .set({ next_escalation_at: escalateAt })
        .where('notification_id', '=', notificationId)
        .where('step', '=', step)
        .execute();
      await this.jobs?.schedule(
        JOB_NOTIFICATION_ESCALATE,
        { notificationId, step },
        escalateAt,
        { dedupeId: `notif_esc:${notificationId}` },
      );
    }
  }

  /** Job handler: the ACK window for `step` lapsed. */
  async escalate(notificationId: string, step: number): Promise<void> {
    const notification = await this.db.kysely
      .selectFrom('core.notification')
      .select(['id', 'acknowledged_at', 'state'])
      .where('id', '=', notificationId)
      .executeTakeFirst();
    if (!notification || notification.acknowledged_at !== null) return;
    if (!['pending', 'delivering'].includes(notification.state)) return;
    await this.advance(notificationId, step);
  }

  private async advance(notificationId: string, fromStep: number): Promise<void> {
    const notification = await this.db.kysely
      .selectFrom('core.notification')
      .select(['contact_id', 'category', 'priority'])
      .where('id', '=', notificationId)
      .executeTakeFirstOrThrow();
    const chain = await this.effectiveChain({
      contactId: notification.contact_id,
      category: notification.category as 'transactional' | 'marketing',
      priority: notification.priority as Priority,
    });
    if (fromStep + 1 < chain.length) {
      await this.deliverStep(notificationId, fromStep + 1);
    } else {
      await this.exhaust(notificationId);
    }
  }

  private async exhaust(notificationId: string): Promise<void> {
    await this.db.tx(async (ctx) => {
      const updated = await ctx.trx
        .updateTable('core.notification')
        .set({ state: 'exhausted' })
        .where('id', '=', notificationId)
        .where('state', 'in', ['pending', 'delivering'])
        .returning('id')
        .executeTakeFirst();
      if (!updated) return;
      const last = await ctx.trx
        .selectFrom('core.delivery_attempt')
        .select('channel')
        .where('notification_id', '=', notificationId)
        .orderBy('step', 'desc')
        .limit(1)
        .executeTakeFirst();
      await ctx.emit({
        aggregateType: 'notification',
        aggregateId: notificationId,
        eventType: 'notification.chain_exhausted',
        payload: { last_channel: last?.channel ?? null },
      });
    });
  }

  /** Client ACK — halts the fallback chain. Idempotent. */
  async acknowledge(notificationId: string, contactId: string): Promise<void> {
    const notification = await this.db.kysely
      .selectFrom('core.notification')
      .select(['id', 'contact_id', 'acknowledged_at'])
      .where('id', '=', notificationId)
      .executeTakeFirst();
    if (!notification) throw new NotFoundException({ code: 'notification_not_found' });
    if (notification.contact_id !== contactId) {
      throw new ForbiddenException({ code: 'not_your_notification' });
    }
    if (notification.acknowledged_at !== null) return;

    await this.db.tx(async (ctx) => {
      await ctx.trx
        .updateTable('core.notification')
        .set({ acknowledged_at: this.clock.now(), state: 'acked' })
        .where('id', '=', notificationId)
        .execute();
      const lastAttempt = await ctx.trx
        .selectFrom('core.delivery_attempt')
        .select('channel')
        .where('notification_id', '=', notificationId)
        .orderBy('step', 'desc')
        .limit(1)
        .executeTakeFirst();
      await ctx.emit({
        aggregateType: 'notification',
        aggregateId: notificationId,
        eventType: 'notification.acknowledged',
        payload: { ack_channel: lastAttempt?.channel ?? null },
      });
    });
    await this.jobs?.cancel(`notif_esc:${notificationId}`);
  }

  // ── Preferences ────────────────────────────────────────────────────

  async getPreferences(contactId: string): Promise<unknown[]> {
    return this.db.kysely
      .selectFrom('core.notification_preference')
      .select(['channel', 'category', 'device_install_id', 'opted_out'])
      .where('contact_id', '=', contactId)
      .execute();
  }

  /** Replace the set; transactional categories are never suppressible. */
  async putPreferences(
    contactId: string,
    prefs: {
      channel: Channel;
      category: 'transactional' | 'marketing';
      device_install_id?: string | null;
      opted_out: boolean;
    }[],
  ): Promise<unknown[]> {
    await this.db.kysely
      .deleteFrom('core.notification_preference')
      .where('contact_id', '=', contactId)
      .execute();
    for (const pref of prefs) {
      await this.db.kysely
        .insertInto('core.notification_preference')
        .values({
          contact_id: contactId,
          channel: pref.channel,
          category: pref.category,
          device_install_id: pref.device_install_id ?? null,
          // Corrected silently, per contract: transactional stays on.
          opted_out: pref.category === 'transactional' ? false : pref.opted_out,
        })
        .execute();
    }
    return this.getPreferences(contactId);
  }

  // ── Internals ──────────────────────────────────────────────────────

  private async attempt(
    notificationId: string,
    step: number,
    channel: Channel,
    input: {
      contactId: string;
      deviceId?: string;
      deviceToken?: string;
      payload: unknown;
    },
  ): Promise<ProviderResult> {
    const result = await this.providers.get(channel).send({
      channel,
      contactId: input.contactId,
      deviceToken: input.deviceToken,
      payload: input.payload,
    });
    await this.db.kysely
      .insertInto('core.delivery_attempt')
      .values({
        notification_id: notificationId,
        step,
        channel,
        device_id: input.deviceId ?? null,
        state: result === 'ok' ? 'sent' : 'failed',
        created_at: this.clock.now(),
      })
      .execute();
    return result;
  }

  private async effectiveChain(params: {
    contactId: string;
    category: 'transactional' | 'marketing';
    priority: Priority;
  }): Promise<ChainStep[]> {
    const chain = CHAINS[params.priority];
    if (params.category === 'transactional') return chain;
    const optOuts = await this.db.kysely
      .selectFrom('core.notification_preference')
      .select('channel')
      .where('contact_id', '=', params.contactId)
      .where('category', '=', 'marketing')
      .where('opted_out', '=', true)
      .where('device_install_id', 'is', null)
      .execute();
    const blocked = new Set(optOuts.map((o) => o.channel));
    return chain.filter((step) => !blocked.has(step.channel));
  }

  /** Next 08:00 local if we are inside quiet hours, else null. */
  private async quietHoursDeferral(contactId: string): Promise<Date | null> {
    const contact = await this.db.kysely
      .selectFrom('core.contact')
      .select('timezone')
      .where('id', '=', contactId)
      .executeTakeFirst();
    const tz = contact?.timezone ?? 'Europe/Brussels';
    const now = this.clock.now();
    const today = localDateOf(tz, now);
    const quietStart = wallClockToUtc(tz, today, QUIET_START_HOUR, 0);
    const morning = wallClockToUtc(tz, today, QUIET_END_HOUR, 0);
    if (now >= quietStart) {
      return wallClockToUtc(tz, addDays(today, 1), QUIET_END_HOUR, 0);
    }
    if (now < morning) {
      return morning;
    }
    return null;
  }
}
