import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Db } from '../src/shared/database/db.service';
import { TestClock } from '../src/shared/jobs/clock';
import { InlineJobScheduler, JobRegistry } from '../src/shared/jobs/job-scheduler';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import {
  NotificationsService,
  ProviderRegistry,
  ChannelProvider,
  ProviderResult,
  JOB_NOTIFICATION_DELIVER,
  JOB_NOTIFICATION_ESCALATE,
} from '../src/modules/notifications/notifications.service';

const uuid = () => crypto.randomUUID();

class FakeProvider implements ChannelProvider {
  calls: { channel: string; deviceToken?: string }[] = [];
  results = new Map<string, ProviderResult>(); // token → result

  async send(input: { channel: string; deviceToken?: string }): Promise<ProviderResult> {
    this.calls.push({ channel: input.channel, deviceToken: input.deviceToken });
    if (input.deviceToken && this.results.has(input.deviceToken)) {
      return this.results.get(input.deviceToken)!;
    }
    return 'ok';
  }
}

describe('notifications (#22)', () => {
  let db: Db;
  let clock: TestClock;
  let scheduler: InlineJobScheduler;
  let notifications: NotificationsService;
  let contacts: ContactsService;
  let push: FakeProvider;
  let sms: FakeProvider;
  let email: FakeProvider;

  beforeAll(() => {
    db = new Db(new ConfigService());
    clock = new TestClock(new Date('2026-08-11T12:00:00Z')); // 14:00 Brussels
    const registry = new JobRegistry();
    scheduler = new InlineJobScheduler(clock, registry);
    const providers = new ProviderRegistry();
    push = new FakeProvider();
    sms = new FakeProvider();
    email = new FakeProvider();
    providers.bind('push', push);
    providers.bind('sms', sms);
    providers.bind('email', email);
    notifications = new NotificationsService(db, clock, providers, scheduler);
    contacts = new ContactsService(db);
    registry.register(JOB_NOTIFICATION_DELIVER, (p) => {
      const { notificationId, step } = p as { notificationId: string; step: number };
      return notifications.deliverStep(notificationId, step);
    });
    registry.register(JOB_NOTIFICATION_ESCALATE, (p) => {
      const { notificationId, step } = p as { notificationId: string; step: number };
      return notifications.escalate(notificationId, step);
    });
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  async function contactWithDevice(token = `tok-${uuid()}`): Promise<string> {
    const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    await notifications.registerDevice(contactId, `install-${uuid()}`, {
      push_token: token,
      platform: 'android',
    });
    return contactId;
  }

  async function attemptsOf(notificationId: string) {
    return db.kysely
      .selectFrom('core.delivery_attempt')
      .selectAll()
      .where('notification_id', '=', notificationId)
      .orderBy('step')
      .execute();
  }

  async function stateOf(notificationId: string): Promise<string> {
    const row = await db.kysely
      .selectFrom('core.notification')
      .select('state')
      .where('id', '=', notificationId)
      .executeTakeFirstOrThrow();
    return row.state;
  }

  it('MANDATED: no ACK walks push → sms → email → exhausted, one attempt per step', async () => {
    const contactId = await contactWithDevice();
    const id = await notifications.send({
      contactId,
      category: 'transactional',
      priority: 'critical_ack',
      kind: 'dispatch_offer',
      payload: { offer_id: uuid() },
    });

    let attempts = await attemptsOf(id);
    expect(attempts.map((a) => a.channel)).toEqual(['push']);

    clock.advance(91_000); // push ACK window (90 s) lapses
    await scheduler.drainDue();
    attempts = await attemptsOf(id);
    expect(attempts.map((a) => a.channel)).toEqual(['push', 'sms']);

    clock.advance(121_000); // sms window (120 s) lapses
    await scheduler.drainDue();
    attempts = await attemptsOf(id);
    expect(attempts.map((a) => a.channel)).toEqual(['push', 'sms', 'email']);

    clock.advance(301_000); // email window (300 s) lapses — chain done
    await scheduler.drainDue();
    expect(await stateOf(id)).toBe('exhausted');

    const exhaustedEvent = await db.kysely
      .selectFrom('core.outbox_event')
      .selectAll()
      .where('event_type', '=', 'notification.chain_exhausted')
      .where('aggregate_id', '=', id)
      .execute();
    expect(exhaustedEvent).toHaveLength(1);
    expect(
      (exhaustedEvent[0].payload as { last_channel: string }).last_channel,
    ).toBe('email');
  });

  it('MANDATED: an ACK after the SMS step halts the chain — no email is ever sent', async () => {
    const contactId = await contactWithDevice();
    const id = await notifications.send({
      contactId,
      category: 'transactional',
      priority: 'critical_ack',
      kind: 'dispatch_offer',
      payload: {},
    });

    clock.advance(91_000);
    await scheduler.drainDue(); // now on the sms step
    expect((await attemptsOf(id)).map((a) => a.channel)).toEqual(['push', 'sms']);

    await notifications.acknowledge(id, contactId);
    expect(await stateOf(id)).toBe('acked');

    clock.advance(10 * 60_000); // sail far past every timer
    await scheduler.drainDue();
    expect((await attemptsOf(id)).map((a) => a.channel)).toEqual(['push', 'sms']);

    const ackEvent = await db.kysely
      .selectFrom('core.outbox_event')
      .selectAll()
      .where('event_type', '=', 'notification.acknowledged')
      .where('aggregate_id', '=', id)
      .execute();
    expect(ackEvent).toHaveLength(1);

    // ACK is idempotent; a stranger's ACK is forbidden.
    await notifications.acknowledge(id, contactId);
    const stranger = await contacts.resolveOrProvision(`kc-${uuid()}`);
    await expect(notifications.acknowledge(id, stranger)).rejects.toMatchObject({
      response: { code: 'not_your_notification' },
    });
  });

  it('dead token: provider Unregistered prunes the device and skips to SMS instantly', async () => {
    const deadToken = `dead-${uuid()}`;
    const contactId = await contactWithDevice(deadToken);
    push.results.set(deadToken, 'invalid_token');

    const id = await notifications.send({
      contactId,
      category: 'transactional',
      priority: 'critical_ack',
      kind: 'dispatch_offer',
      payload: {},
    });

    // No 90 s wait: the push channel provably went nowhere.
    const attempts = await attemptsOf(id);
    expect(attempts.map((a) => a.channel)).toEqual(['push', 'sms']);
    expect(attempts[0].state).toBe('failed');

    const device = await db.kysely
      .selectFrom('core.device')
      .select('state')
      .where('push_token', '=', deadToken)
      .executeTakeFirstOrThrow();
    expect(device.state).toBe('pruned');
  });

  it('quiet hours defer normal-priority sends to 08:00 local; critical_ack ignores them', async () => {
    const contactId = await contactWithDevice();
    clock.set(new Date('2026-08-11T21:30:00Z')); // 23:30 Brussels — quiet

    const normalId = await notifications.send({
      contactId,
      category: 'transactional',
      priority: 'normal',
      kind: 'reminder',
      payload: {},
    });
    expect(await attemptsOf(normalId)).toHaveLength(0); // deferred
    expect(await stateOf(normalId)).toBe('pending');

    const criticalId = await notifications.send({
      contactId,
      category: 'transactional',
      priority: 'critical_ack',
      kind: 'dispatch_offer',
      payload: {},
    });
    expect((await attemptsOf(criticalId)).length).toBe(1); // sent immediately

    // 08:00 Brussels next day = 06:00Z: the deferred send fires.
    clock.set(new Date('2026-08-12T06:00:30Z'));
    await scheduler.drainDue();
    expect((await attemptsOf(normalId)).map((a) => a.channel)).toEqual(['push']);
  });

  it('marketing respects per-channel opt-outs; transactional cannot be opted out', async () => {
    const contactId = await contactWithDevice();
    clock.set(new Date('2026-08-12T10:00:00Z')); // mid-morning, no quiet hours

    const stored = (await notifications.putPreferences(contactId, [
      { channel: 'push', category: 'marketing', opted_out: true },
      { channel: 'push', category: 'transactional', opted_out: true }, // must be corrected
    ])) as { channel: string; category: string; opted_out: boolean }[];
    expect(
      stored.find((p) => p.category === 'transactional')!.opted_out,
    ).toBe(false);

    // Marketing push is the only channel in the 'normal' chain → nothing to send.
    const id = await notifications.send({
      contactId,
      category: 'marketing',
      priority: 'normal',
      kind: 'newsletter',
      payload: {},
    });
    expect(await attemptsOf(id)).toHaveLength(0);
    expect(await stateOf(id)).toBe('exhausted');

    // Transactional to the same contact still delivers.
    const transactional = await notifications.send({
      contactId,
      category: 'transactional',
      priority: 'normal',
      kind: 'receipt',
      payload: {},
    });
    expect((await attemptsOf(transactional)).length).toBe(1);
  });

  it('device registry: upsert by install id, re-register revives a pruned device', async () => {
    const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const installId = `install-${uuid()}`;
    await notifications.registerDevice(contactId, installId, {
      push_token: 'tok-1',
      platform: 'ios',
    });
    await db.kysely
      .updateTable('core.device')
      .set({ state: 'pruned' })
      .where('install_id', '=', installId)
      .execute();
    await notifications.registerDevice(contactId, installId, {
      push_token: 'tok-2',
      platform: 'ios',
      app_version: '2.1.0',
    });

    const devices = await db.kysely
      .selectFrom('core.device')
      .selectAll()
      .where('install_id', '=', installId)
      .execute();
    expect(devices).toHaveLength(1);
    expect(devices[0].push_token).toBe('tok-2');
    expect(devices[0].state).toBe('active');
  });
});
