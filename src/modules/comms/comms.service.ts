import {
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Db, TxContext } from '../../shared/database/db.service';
import { Clock } from '../../shared/jobs/clock';
import { JobScheduler } from '../../shared/jobs/job-scheduler';
import { addDays, localDateOf, wallClockToUtc } from '../../shared/time';
import { normaliseChannelValue } from '../contacts/contacts.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import { TemplatesService } from './templates.service';

export const JOB_SEQUENCE_STEP = 'comms.sequence_step';

export type MessageChannel = 'email' | 'sms' | 'whatsapp' | 'voice_note' | 'in_app';
export type MessageCategory = 'transactional' | 'marketing';

/**
 * Outbound message providers. This registry must ONLY ever be touched by
 * CommsService.send() — the pre-send compliance gate is the single legal
 * send path, and an architecture test enforces the import boundary.
 */
export interface MessageProvider {
  deliver(input: {
    channel: MessageChannel;
    toContactId: string;
    body: string;
  }): Promise<{ providerMessageId?: string } | 'failed'>;
}

@Injectable()
export class MessageProviderRegistry {
  private readonly providers = new Map<MessageChannel, MessageProvider>();

  bind(channel: MessageChannel, provider: MessageProvider): void {
    this.providers.set(channel, provider);
  }

  get(channel: MessageChannel): MessageProvider | undefined {
    return this.providers.get(channel);
  }
}

export interface OutboundDraft {
  contactId: string;
  channel: MessageChannel;
  category: MessageCategory;
  /** Literal body, or omit and provide templateKey. */
  body?: string;
  templateKey?: string;
  templateVars?: Record<string, string | number>;
  propertyId?: string;
  conversationId?: string;
  templateVersionId?: string;
  /** ISO country the recipient is addressed in; platform default BE. */
  country?: string;
}

interface GateVerdict {
  consent_ok: boolean;
  lawful_basis_ok: boolean;
  suppression_ok: boolean;
  art14_required: boolean;
  verdict: 'pass' | 'blocked';
  detail: Record<string, unknown>;
}

const ELECTRONIC_CHANNELS: MessageChannel[] = ['email', 'sms', 'whatsapp'];
const QUIET_START_HOUR = 22;
const QUIET_END_HOUR = 8;

@Injectable()
export class CommsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly providers: MessageProviderRegistry,
    private readonly templates: TemplatesService,
    private readonly pipelines: PipelinesService,
    @Optional() private readonly jobs?: JobScheduler,
  ) {}

  // ── The pre-send compliance gate ───────────────────────────────────

  private async evaluateGate(draft: OutboundDraft): Promise<GateVerdict> {
    const contact = await this.db.kysely
      .selectFrom('core.contact')
      .select(['id', 'lifecycle_state', 'processing_restricted', 'idp_subject_id'])
      .where('id', '=', draft.contactId)
      .executeTakeFirst();

    const suppression_ok =
      !!contact &&
      contact.lifecycle_state !== 'erased' &&
      !contact.processing_restricted;

    let consent_ok = true;
    let lawful_basis_ok = true;
    const detail: Record<string, unknown> = {};

    const isElectronic = ELECTRONIC_CHANNELS.includes(draft.channel);
    const needsConsent = isElectronic && draft.category === 'marketing';
    if (needsConsent) {
      const consent = await this.db.kysely
        .selectFrom('privacy.consent')
        .select('id')
        .where('contact_id', '=', draft.contactId)
        .where('purpose', '=', 'marketing')
        .where('withdrawn_at', 'is', null)
        .executeTakeFirst();
      if (consent) {
        detail.basis = 'consent';
      } else {
        // ePrivacy default-block: only a per-country, legally signed-off
        // channel_policy row lifts it. Absence of a row means BLOCK.
        const policy = await this.db.kysely
          .selectFrom('core.channel_policy')
          .select('allowed')
          .where('country', '=', draft.country ?? 'BE')
          .where('channel', '=', draft.channel as 'email' | 'sms' | 'whatsapp')
          .executeTakeFirst();
        consent_ok = false;
        lawful_basis_ok = policy?.allowed === true;
        detail.basis = lawful_basis_ok ? 'country_policy' : 'none';
      }
    }

    // Article 14: data not collected from the subject (scraped, never
    // registered) and no disclosure on record yet → attach on first send.
    let art14_required = false;
    if (contact && contact.idp_subject_id === null) {
      const disclosed = await this.db.kysely
        .selectFrom('core.disclosure')
        .select('id')
        .where('contact_id', '=', draft.contactId)
        .where('kind', '=', 'article_14')
        .executeTakeFirst();
      art14_required = !disclosed;
    }

    const verdict: GateVerdict['verdict'] =
      suppression_ok && (consent_ok || lawful_basis_ok) ? 'pass' : 'blocked';
    return { consent_ok, lawful_basis_ok, suppression_ok, art14_required, verdict, detail };
  }

  /**
   * THE ONLY SEND PATH. Gate → persist verdict → (blocked? stop) →
   * attach Art 14 disclosure with proof → provider → state tracking.
   */
  async send(draft: OutboundDraft): Promise<{ messageId: string; state: string }> {
    const now = this.clock.now();

    // Template path: render in the recipient's locale (en fallback) and
    // record the exact version sent.
    if (draft.templateKey) {
      const contact = await this.db.kysely
        .selectFrom('core.contact')
        .select('locale')
        .where('id', '=', draft.contactId)
        .executeTakeFirst();
      const rendered = await this.templates.render(
        draft.templateKey,
        contact?.locale ?? 'en',
        draft.templateVars ?? {},
      );
      draft = {
        ...draft,
        body: rendered.body,
        templateVersionId: rendered.templateVersionId,
      };
    }
    if (!draft.body) {
      throw new NotFoundException({ code: 'body_or_template_required' });
    }

    const conversationId =
      draft.conversationId ??
      (await this.findOrCreateConversation(draft.contactId, draft.propertyId));

    const gate = await this.evaluateGate(draft);
    const messageId = await this.db.tx(async (ctx) => {
      const message = await ctx.trx
        .insertInto('core.message')
        .values({
          conversation_id: conversationId,
          direction: 'outbound',
          channel: draft.channel,
          body: draft.body,
          template_version_id: draft.templateVersionId ?? null,
          state: 'gated',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await ctx.trx
        .insertInto('core.compliance_check')
        .values({
          message_id: message.id,
          consent_ok: gate.consent_ok,
          lawful_basis_ok: gate.lawful_basis_ok,
          suppression_ok: gate.suppression_ok,
          art14_required: gate.art14_required,
          verdict: gate.verdict,
          detail: JSON.stringify(gate.detail),
          checked_at: now,
        })
        .execute();

      if (gate.verdict === 'blocked') {
        await ctx.trx
          .updateTable('core.message')
          .set({ state: 'blocked' })
          .where('id', '=', message.id)
          .execute();
        // Ops-only event — never fanned out to external webhooks.
        await ctx.emit({
          aggregateType: 'message',
          aggregateId: message.id,
          eventType: 'message.blocked_by_gate',
          payload: { gate_reason: gate.detail },
        });
        return message.id;
      }

      if (gate.art14_required) {
        // Proof-of-send: the disclosure row references this very message.
        await ctx.trx
          .insertInto('core.disclosure')
          .values({ contact_id: draft.contactId, message_id: message.id })
          .onConflict((oc) => oc.columns(['contact_id', 'kind']).doNothing())
          .execute();
      }
      await ctx.trx
        .updateTable('core.message')
        .set({ state: 'queued' })
        .where('id', '=', message.id)
        .execute();
      return message.id;
    });

    if (gate.verdict === 'blocked') {
      return { messageId, state: 'blocked' };
    }

    // Provider handoff. in_app messages are storage-only: delivery IS the
    // thread; everything else goes out through an adapter.
    let finalState = 'sent';
    let providerMessageId: string | null = null;
    if (draft.channel !== 'in_app') {
      const provider = this.providers.get(draft.channel);
      const result = provider
        ? await provider.deliver({
            channel: draft.channel,
            toContactId: draft.contactId,
            body: draft.body,
          })
        : 'failed';
      if (result === 'failed') {
        finalState = 'failed';
      } else {
        providerMessageId = result.providerMessageId ?? null;
      }
    }
    await this.db.tx(async (ctx) => {
      await ctx.trx
        .updateTable('core.message')
        .set({ state: finalState, sent_at: now, provider_message_id: providerMessageId })
        .where('id', '=', messageId)
        .execute();
      await ctx.trx
        .updateTable('core.conversation')
        .set({ last_message_at: now })
        .where('id', '=', conversationId)
        .execute();
      await ctx.emit({
        aggregateType: 'message',
        aggregateId: messageId,
        eventType: 'message.delivery_changed',
        payload: { channel: draft.channel, state: finalState },
      });
    });
    return { messageId, state: finalState };
  }

  // ── Inbound routing ────────────────────────────────────────────────

  /**
   * Match replies to contact, property and thread: provider id first,
   * then the normalised channel value. Any inbound reply stops active
   * sequence enrollments for that contact (stop-on-reply).
   */
  async routeInbound(input: {
    channel: MessageChannel;
    fromValue?: string;
    body: string;
    inReplyToProviderId?: string;
    providerMessageId?: string;
  }): Promise<{ messageId: string; conversationId: string; contactId: string } | null> {
    const now = this.clock.now();

    let conversationId: string | undefined;
    let contactId: string | undefined;

    if (input.inReplyToProviderId) {
      const original = await this.db.kysely
        .selectFrom('core.message as m')
        .innerJoin('core.conversation as c', 'c.id', 'm.conversation_id')
        .select(['c.id as conversation_id', 'c.contact_id'])
        .where('m.provider_message_id', '=', input.inReplyToProviderId)
        .executeTakeFirst();
      if (original) {
        conversationId = original.conversation_id;
        contactId = original.contact_id;
      }
    }
    if (!conversationId && input.fromValue) {
      const kind = input.channel === 'email' ? 'email' : 'phone';
      const match = await this.db.kysely
        .selectFrom('core.contact_channel as ch')
        .innerJoin('core.contact as co', 'co.id', 'ch.contact_id')
        .select(['co.id', 'co.merged_into'])
        .where('ch.kind', '=', kind)
        .where('ch.value_normalised', '=', normaliseChannelValue(kind, input.fromValue))
        .where('co.lifecycle_state', '<>', 'erased')
        .executeTakeFirst();
      if (match) {
        contactId = match.merged_into ?? match.id;
        conversationId = await this.findOrCreateConversation(contactId);
      }
    }
    if (!conversationId || !contactId) return null; // unroutable → ops queue

    const messageId = await this.db.tx(async (ctx) => {
      const message = await ctx.trx
        .insertInto('core.message')
        .values({
          conversation_id: conversationId!,
          direction: 'inbound',
          channel: input.channel,
          body: input.body,
          state: 'received',
          provider_message_id: input.providerMessageId ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await ctx.trx
        .updateTable('core.conversation')
        .set({ last_message_at: now })
        .where('id', '=', conversationId!)
        .execute();

      // Stop-on-reply: silence every active enrollment for this contact.
      const stopped = await ctx.trx
        .updateTable('core.sequence_enrollment')
        .set({ state: 'stopped_on_reply' })
        .where('contact_id', '=', contactId!)
        .where('state', '=', 'active')
        .returning('id')
        .execute();
      for (const enrollment of stopped) {
        await this.jobs?.cancel(`sequence:${enrollment.id}`);
      }

      await ctx.emit({
        aggregateType: 'message',
        aggregateId: message.id,
        eventType: 'message.received',
        payload: { channel: input.channel },
      });
      return message.id;
    });

    // An inbound message is an inquiry signal for the demand pipeline.
    const conversation = await this.db.kysely
      .selectFrom('core.conversation')
      .select('property_id')
      .where('id', '=', conversationId)
      .executeTakeFirstOrThrow();
    if (conversation.property_id) {
      await this.pipelines.recordInboundInquiry({
        contactId,
        propertyId: conversation.property_id,
        payload: { via: 'inbound_message' },
      });
    }

    return { messageId, conversationId, contactId };
  }

  // ── Sequencer ──────────────────────────────────────────────────────

  async enroll(sequenceName: string, contactId: string): Promise<string> {
    const sequence = await this.db.kysely
      .selectFrom('core.sequence')
      .selectAll()
      .where('name', '=', sequenceName)
      .where('enabled', '=', true)
      .executeTakeFirst();
    if (!sequence) throw new NotFoundException({ code: 'sequence_not_found' });

    const steps = sequence.steps as { delay_minutes: number }[];
    const firstAt = new Date(
      this.clock.now().getTime() + (steps[0]?.delay_minutes ?? 0) * 60_000,
    );
    const enrollment = await this.db.kysely
      .insertInto('core.sequence_enrollment')
      .values({ sequence_id: sequence.id, contact_id: contactId, next_step_at: firstAt })
      .onConflict((oc) => oc.columns(['sequence_id', 'contact_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!enrollment) {
      const existing = await this.db.kysely
        .selectFrom('core.sequence_enrollment')
        .select('id')
        .where('sequence_id', '=', sequence.id)
        .where('contact_id', '=', contactId)
        .executeTakeFirstOrThrow();
      return existing.id;
    }
    await this.jobs?.schedule(
      JOB_SEQUENCE_STEP,
      { enrollmentId: enrollment.id },
      firstAt,
      { dedupeId: `sequence:${enrollment.id}` },
    );
    return enrollment.id;
  }

  /** Job handler: run the current step through the gate, arm the next. */
  async runSequenceStep(enrollmentId: string): Promise<void> {
    const enrollment = await this.db.kysely
      .selectFrom('core.sequence_enrollment as e')
      .innerJoin('core.sequence as s', 's.id', 'e.sequence_id')
      .selectAll('e')
      .select('s.steps')
      .where('e.id', '=', enrollmentId)
      .executeTakeFirst();
    if (!enrollment || enrollment.state !== 'active') return;

    const now = this.clock.now();
    // Quiet-hours-aware: outreach never lands at night; re-arm for morning.
    const deferUntil = await this.quietHoursDeferral(enrollment.contact_id);
    if (deferUntil) {
      await this.jobs?.schedule(
        JOB_SEQUENCE_STEP,
        { enrollmentId },
        deferUntil,
        { dedupeId: `sequence:${enrollmentId}` },
      );
      return;
    }

    const steps = enrollment.steps as {
      channel: MessageChannel;
      category: MessageCategory;
      body?: string;
      template_key?: string;
      vars?: Record<string, string | number>;
      delay_minutes: number;
    }[];
    const step = steps[enrollment.current_step];
    if (!step) {
      await this.db.kysely
        .updateTable('core.sequence_enrollment')
        .set({ state: 'completed', next_step_at: null })
        .where('id', '=', enrollmentId)
        .execute();
      return;
    }

    const result = await this.send({
      contactId: enrollment.contact_id,
      channel: step.channel,
      category: step.category,
      body: step.body,
      templateKey: step.template_key,
      templateVars: step.vars,
    });
    if (result.state === 'blocked') {
      await this.db.kysely
        .updateTable('core.sequence_enrollment')
        .set({ state: 'blocked_by_gate', next_step_at: null })
        .where('id', '=', enrollmentId)
        .execute();
      return;
    }

    const nextIndex = enrollment.current_step + 1;
    if (nextIndex >= steps.length) {
      await this.db.kysely
        .updateTable('core.sequence_enrollment')
        .set({ state: 'completed', current_step: nextIndex, next_step_at: null })
        .where('id', '=', enrollmentId)
        .execute();
      return;
    }
    const nextAt = new Date(now.getTime() + steps[nextIndex].delay_minutes * 60_000);
    await this.db.kysely
      .updateTable('core.sequence_enrollment')
      .set({ current_step: nextIndex, next_step_at: nextAt })
      .where('id', '=', enrollmentId)
      .execute();
    await this.jobs?.schedule(
      JOB_SEQUENCE_STEP,
      { enrollmentId },
      nextAt,
      { dedupeId: `sequence:${enrollmentId}` },
    );
  }

  // ── Thread views (contract) ────────────────────────────────────────

  async listConversations(contactId: string): Promise<unknown[]> {
    return this.db.kysely
      .selectFrom('core.conversation')
      .select(['id', 'topic', 'property_id', 'last_message_at'])
      .where('contact_id', '=', contactId)
      .orderBy('last_message_at', 'desc')
      .limit(100)
      .execute();
  }

  async listMessages(conversationId: string, contactId: string): Promise<unknown[]> {
    const conversation = await this.db.kysely
      .selectFrom('core.conversation')
      .select('id')
      .where('id', '=', conversationId)
      .where('contact_id', '=', contactId)
      .executeTakeFirst();
    if (!conversation) throw new NotFoundException({ code: 'conversation_not_found' });
    return this.db.kysely
      .selectFrom('core.message')
      .select(['id', 'direction', 'channel', 'body', 'state', 'created_at'])
      .where('conversation_id', '=', conversationId)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
  }

  async findOrCreateConversation(
    contactId: string,
    propertyId?: string,
  ): Promise<string> {
    let q = this.db.kysely
      .selectFrom('core.conversation')
      .select('id')
      .where('contact_id', '=', contactId);
    q = propertyId
      ? q.where('property_id', '=', propertyId)
      : q.where('property_id', 'is', null);
    const existing = await q.executeTakeFirst();
    if (existing) return existing.id;
    const row = await this.db.kysely
      .insertInto('core.conversation')
      .values({ contact_id: contactId, property_id: propertyId ?? null })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

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
    if (now >= quietStart) return wallClockToUtc(tz, addDays(today, 1), QUIET_END_HOUR, 0);
    if (now < morning) return morning;
    return null;
  }
}
