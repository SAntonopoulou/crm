import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Db } from '../src/shared/database/db.service';
import { TestClock } from '../src/shared/jobs/clock';
import { InlineJobScheduler, JobRegistry } from '../src/shared/jobs/job-scheduler';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { PipelinesService } from '../src/modules/pipelines/pipelines.service';
import {
  CommsService,
  MessageProviderRegistry,
  MessageProvider,
  JOB_SEQUENCE_STEP,
} from '../src/modules/comms/comms.service';

const uuid = () => crypto.randomUUID();

class FakeMessageProvider implements MessageProvider {
  deliveries: { channel: string; toContactId: string; body: string }[] = [];
  async deliver(input: {
    channel: 'email' | 'sms' | 'whatsapp' | 'voice_note' | 'in_app';
    toContactId: string;
    body: string;
  }): Promise<{ providerMessageId?: string }> {
    this.deliveries.push(input);
    return { providerMessageId: `prov-${this.deliveries.length}-${uuid()}` };
  }
}

describe('comms (#23)', () => {
  let db: Db;
  let clock: TestClock;
  let scheduler: InlineJobScheduler;
  let comms: CommsService;
  let contacts: ContactsService;
  let emailProvider: FakeMessageProvider;

  beforeAll(() => {
    const config = new ConfigService();
    db = new Db(config);
    clock = new TestClock(new Date('2026-08-11T10:00:00Z')); // midday Brussels
    const registry = new JobRegistry();
    scheduler = new InlineJobScheduler(clock, registry);
    const providers = new MessageProviderRegistry();
    emailProvider = new FakeMessageProvider();
    providers.bind('email', emailProvider);
    contacts = new ContactsService(db);
    const pipelines = new PipelinesService(db, clock, scheduler, config);
    comms = new CommsService(db, clock, providers, pipelines, scheduler);
    registry.register(JOB_SEQUENCE_STEP, (p) =>
      comms.runSequenceStep((p as { enrollmentId: string }).enrollmentId),
    );
    registry.register('pipeline.sla_breach', async () => {}); // pipelines side effect
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  /** A scraped, never-registered owner — the Art 14 / cold-outreach case. */
  async function scrapedContact(email: string): Promise<string> {
    const row = await db.kysely
      .insertInto('core.contact')
      .values({ lifecycle_state: 'unregistered', display_name: 'Scraped Owner' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db.kysely
      .insertInto('core.contact_channel')
      .values({ contact_id: row.id, kind: 'email', value_normalised: email.toLowerCase() })
      .execute();
    return row.id;
  }

  async function messageRow(messageId: string) {
    return db.kysely
      .selectFrom('core.message')
      .selectAll()
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();
  }

  it('GATE default-blocks cold marketing email; nothing reaches the provider', async () => {
    const contactId = await scrapedContact(`cold-${uuid()}@example.com`);
    const before = emailProvider.deliveries.length;

    const result = await comms.send({
      contactId,
      channel: 'email',
      category: 'marketing',
      body: 'Sell your house with us!',
    });
    expect(result.state).toBe('blocked');
    expect(emailProvider.deliveries.length).toBe(before); // provider untouched

    const check = await db.kysely
      .selectFrom('core.compliance_check')
      .selectAll()
      .where('message_id', '=', result.messageId)
      .executeTakeFirstOrThrow();
    expect(check.verdict).toBe('blocked');
    expect(check.consent_ok).toBe(false);
    expect(check.lawful_basis_ok).toBe(false);

    const blockedEvent = await db.kysely
      .selectFrom('core.outbox_event')
      .select('id')
      .where('event_type', '=', 'message.blocked_by_gate')
      .where('aggregate_id', '=', result.messageId)
      .execute();
    expect(blockedEvent).toHaveLength(1);
  });

  it('consent unblocks, and the first send to an indirect contact carries the Art 14 disclosure with proof', async () => {
    const contactId = await scrapedContact(`consented-${uuid()}@example.com`);
    await db.kysely
      .insertInto('privacy.consent')
      .values({ contact_id: contactId, purpose: 'marketing' })
      .execute();

    const first = await comms.send({
      contactId,
      channel: 'email',
      category: 'marketing',
      body: 'Hello — about your property…',
    });
    expect(first.state).toBe('sent');

    const disclosure = await db.kysely
      .selectFrom('core.disclosure')
      .selectAll()
      .where('contact_id', '=', contactId)
      .execute();
    expect(disclosure).toHaveLength(1);
    expect(disclosure[0].message_id).toBe(first.messageId); // proof of send

    // Second send: no duplicate disclosure.
    await comms.send({ contactId, channel: 'email', category: 'marketing', body: 'Follow-up' });
    expect(
      (await db.kysely
        .selectFrom('core.disclosure')
        .selectAll()
        .where('contact_id', '=', contactId)
        .execute()).length,
    ).toBe(1);
  });

  it('a signed-off country channel policy lifts the block without consent', async () => {
    await db.kysely
      .insertInto('core.channel_policy')
      .values({ country: 'XX', channel: 'email', allowed: true, note: 'test jurisdiction' })
      .onConflict((oc) => oc.columns(['country', 'channel']).doNothing())
      .execute();
    const contactId = await scrapedContact(`policy-${uuid()}@example.com`);

    const result = await comms.send({
      contactId,
      channel: 'email',
      category: 'marketing',
      body: 'Legal in XX',
      country: 'XX',
    });
    expect(result.state).toBe('sent');
    const check = await db.kysely
      .selectFrom('core.compliance_check')
      .select('detail')
      .where('message_id', '=', result.messageId)
      .executeTakeFirstOrThrow();
    expect((check.detail as { basis: string }).basis).toBe('country_policy');
  });

  it('suppresses sends to restricted or erased contacts regardless of consent', async () => {
    const contactId = await scrapedContact(`frozen-${uuid()}@example.com`);
    await db.kysely
      .insertInto('privacy.consent')
      .values({ contact_id: contactId, purpose: 'marketing' })
      .execute();
    await db.kysely
      .updateTable('core.contact')
      .set({ processing_restricted: true })
      .where('id', '=', contactId)
      .execute();

    const result = await comms.send({
      contactId,
      channel: 'email',
      category: 'marketing',
      body: 'should never leave',
    });
    expect(result.state).toBe('blocked');
  });

  it('in-app transactional messages pass the gate and stay storage-only', async () => {
    const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const result = await comms.send({
      contactId,
      channel: 'in_app',
      category: 'transactional',
      body: 'Your viewing is confirmed.',
    });
    expect(result.state).toBe('sent');
    expect((await messageRow(result.messageId)).provider_message_id).toBeNull();
  });

  it('inbound routing: provider id → same thread; channel value → contact; sequences stop on reply', async () => {
    const email = `owner-${uuid()}@example.com`;
    const contactId = await scrapedContact(email);
    await db.kysely
      .insertInto('privacy.consent')
      .values({ contact_id: contactId, purpose: 'marketing' })
      .execute();

    // Enroll in a two-step sequence; step 1 goes out.
    await db.kysely
      .insertInto('core.sequence')
      .values({
        name: `seq-${uuid()}`,
        steps: JSON.stringify([
          { channel: 'email', category: 'marketing', body: 'step 1', delay_minutes: 0 },
          { channel: 'email', category: 'marketing', body: 'step 2', delay_minutes: 60 },
        ]),
      })
      .returning('name')
      .executeTakeFirstOrThrow()
      .then((s) => comms.enroll(s.name, contactId));
    await scheduler.drainDue();
    const sentSoFar = emailProvider.deliveries.filter((d) => d.toContactId === contactId);
    expect(sentSoFar.map((d) => d.body)).toEqual(['step 1']);

    // The owner replies by the provider-id thread.
    const outbound = await db.kysely
      .selectFrom('core.message')
      .select(['provider_message_id', 'conversation_id'])
      .where('state', '=', 'sent')
      .where('direction', '=', 'outbound')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    const routed = await comms.routeInbound({
      channel: 'email',
      fromValue: email,
      inReplyToProviderId: outbound.provider_message_id!,
      body: 'Yes, I am interested',
    });
    expect(routed?.contactId).toBe(contactId);
    expect(routed?.conversationId).toBe(outbound.conversation_id);

    // Step 2 must NEVER go out.
    clock.advance(2 * 3_600_000);
    await scheduler.drainDue();
    expect(
      emailProvider.deliveries.filter((d) => d.toContactId === contactId).map((d) => d.body),
    ).toEqual(['step 1']);
    const enrollment = await db.kysely
      .selectFrom('core.sequence_enrollment')
      .select('state')
      .where('contact_id', '=', contactId)
      .executeTakeFirstOrThrow();
    expect(enrollment.state).toBe('stopped_on_reply');

    // Unroutable senders are refused, not guessed.
    expect(
      await comms.routeInbound({
        channel: 'email',
        fromValue: `stranger-${uuid()}@example.com`,
        body: 'who am I?',
      }),
    ).toBeNull();
  });

  it('ARCHITECTURE: the message provider registry is only referenced inside the comms module', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (path.endsWith('.ts') && !path.includes(`modules${
          require('node:path').sep}comms`)) {
          if (readFileSync(path, 'utf8').includes('MessageProviderRegistry')) {
            offenders.push(path);
          }
        }
      }
    };
    walk(join(__dirname, '..', 'src'));
    expect(offenders).toEqual([]); // the gate is the only send path
  });
});
