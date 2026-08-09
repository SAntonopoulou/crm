import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { AuditLog, ReasonRequiredError } from '../src/shared/audit/audit-log.service';
import { Db } from '../src/shared/database/db.service';
import { TestClock } from '../src/shared/jobs/clock';
import { InlineJobScheduler, JobRegistry } from '../src/shared/jobs/job-scheduler';
import { ProvenanceResolver } from '../src/shared/provenance/provenance-resolver';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { PropertiesService } from '../src/modules/properties/properties.service';
import { IngestService } from '../src/modules/properties/ingest.service';
import { SuppressionService } from '../src/modules/properties/suppression.service';
import {
  PrivacyService,
  IdpAdminPort,
  KmsPort,
  JOB_DSR_ESCALATION,
} from '../src/modules/privacy/privacy.service';
import { LocalDiskStorage } from '../src/modules/platform/media.service';

const uuid = () => crypto.randomUUID();
const DAY = 24 * 3_600_000;

class FakeIdp extends IdpAdminPort {
  deleted: string[] = [];
  failNext = false;
  async deleteSubject(subjectId: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('keycloak down');
    }
    this.deleted.push(subjectId);
  }
}

class FakeKms extends KmsPort {
  destroyed: string[] = [];
  async destroyKey(keyId: string): Promise<void> {
    this.destroyed.push(keyId);
  }
}

describe('privacy & audit completion (#24)', () => {
  let db: Db;
  let clock: TestClock;
  let scheduler: InlineJobScheduler;
  let privacy: PrivacyService;
  let contacts: ContactsService;
  let suppression: SuppressionService;
  let ingest: IngestService;
  let idp: FakeIdp;
  let kms: FakeKms;

  beforeAll(() => {
    const config = new ConfigService();
    db = new Db(config);
    clock = new TestClock(new Date('2026-08-12T09:00:00Z'));
    const registry = new JobRegistry();
    scheduler = new InlineJobScheduler(clock, registry);
    contacts = new ContactsService(db);
    suppression = new SuppressionService(db, config);
    const audit = new AuditLog(db);
    idp = new FakeIdp();
    kms = new FakeKms();
    const storage = new LocalDiskStorage(
      new ConfigService({ MEDIA_STORAGE_DIR: 'var/test-uploads' }),
    );
    privacy = new PrivacyService(db, clock, contacts, suppression, audit, idp, kms, scheduler, storage);
    const properties = new PropertiesService(db, new ProvenanceResolver(), config);
    ingest = new IngestService(db, properties, contacts, suppression);
    registry.register(JOB_DSR_ESCALATION, (p) =>
      privacy.escalateDsr((p as { dsrId: string }).dsrId),
    );
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  it('MANDATED: erasure end-to-end — suppression, IdP, DEK, scrub, and re-ingest stays dead', async () => {
    const email = `erase-me-${uuid()}@example.com`;
    const phone = '+32470111222';
    const sub = `kc-${uuid()}`;
    const dekId = uuid();

    const contactId = await contacts.resolveOrProvision(sub);
    await contacts.addChannel(contactId, 'email', email, true);
    await contacts.addChannel(contactId, 'phone', phone);
    await db.kysely
      .updateTable('core.contact')
      .set({ dek_id: dekId, display_name: 'Erase Me' })
      .where('id', '=', contactId)
      .execute();

    const dsr = await privacy.fileDsr(contactId, 'erasure');
    await privacy.processErasure(dsr.id, uuid());

    // Local scrub + tombstone.
    const contact = await db.kysely
      .selectFrom('core.contact')
      .selectAll()
      .where('id', '=', contactId)
      .executeTakeFirstOrThrow();
    expect(contact.lifecycle_state).toBe('erased');
    expect(contact.idp_subject_id).toBeNull();
    expect(contact.display_name).toBeNull();

    // Every propagation confirmed, in order of guarantees.
    expect(idp.deleted).toContain(sub);
    expect(kms.destroyed).toContain(dekId);
    const propagations = await db.kysely
      .selectFrom('privacy.erasure_propagation')
      .select(['target', 'state'])
      .where('dsr_id', '=', dsr.id)
      .execute();
    expect(new Map(propagations.map((p) => [p.target, p.state]))).toEqual(
      new Map([
        ['suppression_list', 'confirmed'],
        ['keycloak', 'confirmed'],
        ['kms_dek', 'confirmed'],
      ]),
    );

    const dsrRow = await db.kysely
      .selectFrom('privacy.dsr')
      .selectAll()
      .where('id', '=', dsr.id)
      .executeTakeFirstOrThrow();
    expect(dsrRow.state).toBe('completed');
    expect(
      (dsrRow.completion_audit as { suppressed_identifiers: number }).suppressed_identifiers,
    ).toBe(2);

    const erasedEvent = await db.kysely
      .selectFrom('core.outbox_event')
      .select('id')
      .where('event_type', '=', 'privacy.erased')
      .where('aggregate_id', '=', contactId)
      .execute();
    expect(erasedEvent).toHaveLength(1);

    // The scraper re-delivers the same person next week → suppressed, dead.
    const batch = await ingest.processBatch(
      {
        source: { name: `portal-${uuid()}`, kind: 'portal_scrape' },
        records: [
          {
            idempotency_key: `rec-${uuid()}`,
            kind: 'owner_contact',
            payload: { contact: { emails: [email], phones: [phone], role_hint: 'owner' } },
            provenance: [{ collected_at: new Date().toISOString(), method: 'scraped' }],
          },
        ],
      },
      `batch-${uuid()}`,
    );
    const record = await db.kysely
      .selectFrom('core.ingest_record')
      .selectAll()
      .where('run_id', '=', batch.batch_id)
      .executeTakeFirstOrThrow();
    expect(record.outcome).toBe('suppressed');
    expect(record.payload).toBeNull();
    expect(record.contact_id).toBeNull();
  });

  it('a failed IdP propagation leaves the DSR in_progress and retryable', async () => {
    const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    await contacts.addChannel(contactId, 'email', `retry-${uuid()}@example.com`);
    const dsr = await privacy.fileDsr(contactId, 'erasure');

    idp.failNext = true;
    await privacy.processErasure(dsr.id, uuid());
    let dsrRow = await db.kysely
      .selectFrom('privacy.dsr')
      .select('state')
      .where('id', '=', dsr.id)
      .executeTakeFirstOrThrow();
    expect(dsrRow.state).toBe('in_progress'); // not silently half-completed
    const failed = await db.kysely
      .selectFrom('privacy.erasure_propagation')
      .select('state')
      .where('dsr_id', '=', dsr.id)
      .where('target', '=', 'keycloak')
      .executeTakeFirstOrThrow();
    expect(failed.state).toBe('failed');

    // Retry succeeds and completes.
    await privacy.processErasure(dsr.id, uuid());
    dsrRow = await db.kysely
      .selectFrom('privacy.dsr')
      .select('state')
      .where('id', '=', dsr.id)
      .executeTakeFirstOrThrow();
    expect(dsrRow.state).toBe('completed');
  });

  it('MANDATED: purpose-bound access expires — masked after the sweep, reveal needs a reason', async () => {
    const agentId = uuid();
    const subject = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const email = `subject-${uuid()}@example.com`;
    await contacts.addChannel(subject, 'email', email, true);
    await db.kysely
      .updateTable('core.contact')
      .set({ display_name: 'Sofia Subject' })
      .where('id', '=', subject)
      .execute();

    // Appointment fixture + grant window: now-1h .. now+2h.
    const prop = await db.kysely
      .insertInto('core.property')
      .values({ canonical_key: `grant-${uuid()}`, address_normalised: '{}' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const listing = await db.kysely
      .insertInto('core.listing')
      .values({ property_id: prop.id, channel: 'sale' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const appointment = await db.kysely
      .insertInto('core.appointment')
      .values({
        property_id: prop.id,
        listing_id: listing.id,
        viewer_contact_id: subject,
        during: sql`tstzrange(${clock.now()}, ${new Date(clock.now().getTime() + 3_600_000)})`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const windowEnd = new Date(clock.now().getTime() + 2 * 3_600_000);
    await db.kysely
      .insertInto('core.access_grant')
      .values({
        grantee_agent_id: agentId,
        subject_contact_id: subject,
        appointment_id: appointment.id,
        during: sql`tstzrange(${new Date(clock.now().getTime() - 3_600_000)}, ${windowEnd})`,
      })
      .execute();

    // Inside the window: full details, read audited.
    const inside = await privacy.contactViewForAgent(agentId, subject);
    expect(inside.channels[0]).toMatchObject({ value: email, masked: false });
    expect(inside.display_name).toBe('Sofia Subject');
    const reads = await db.kysely
      .selectFrom('audit.pii_access_log')
      .select('action')
      .where('actor_id', '=', agentId)
      .where('subject_contact_id', '=', subject)
      .execute();
    expect(reads.some((r) => r.action === 'read')).toBe(true);

    // Window closes; the sweep revokes; the view is masked again.
    clock.advance(3 * 3_600_000);
    expect(await privacy.revokeExpiredGrants()).toBeGreaterThanOrEqual(1);
    const outside = await privacy.contactViewForAgent(agentId, subject);
    expect(outside.channels[0].masked).toBe(true);
    expect(outside.channels[0].value).not.toContain(email.split('@')[0].slice(1));
    expect(outside.display_name).toBe('S***');

    // Reveal-on-click: blank reason refused, real reason audited.
    await expect(
      privacy.revealChannel(agentId, subject, 'email', '  '),
    ).rejects.toThrow(ReasonRequiredError);
    const revealed = await privacy.revealChannel(
      agentId, subject, 'email', 'viewer asked me to resend directions',
    );
    expect(revealed).toBe(email);
    const reveals = await db.kysely
      .selectFrom('audit.pii_access_log')
      .selectAll()
      .where('actor_id', '=', agentId)
      .where('action', '=', 'reveal')
      .execute();
    expect(reveals).toHaveLength(1);
    expect(reveals[0].reason).toContain('directions');

    // A second appointment creates a NEW grant — expiry of one never
    // bleeds into the other.
    await db.kysely
      .insertInto('core.access_grant')
      .values({
        grantee_agent_id: agentId,
        subject_contact_id: subject,
        appointment_id: appointment.id,
        during: sql`tstzrange(${clock.now()}, ${new Date(clock.now().getTime() + 3_600_000)})`,
      })
      .execute();
    const again = await privacy.contactViewForAgent(agentId, subject);
    expect(again.channels[0].masked).toBe(false);
  });

  it('#40: access request assembles the cross-table export; only the subject downloads it', async () => {
    const email = `access-${uuid()}@example.com`;
    const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    await contacts.addChannel(contactId, 'email', email, true);
    await db.kysely
      .insertInto('privacy.consent')
      .values({ contact_id: contactId, purpose: 'marketing' })
      .execute();

    const dsr = await privacy.fileDsr(contactId, 'access');
    const exportKey = await privacy.processAccessRequest(dsr.id, uuid());
    expect(exportKey).toContain(dsr.id);

    const dsrRow = await db.kysely
      .selectFrom('privacy.dsr')
      .select('state')
      .where('id', '=', dsr.id)
      .executeTakeFirstOrThrow();
    expect(dsrRow.state).toBe('completed');

    const data = JSON.parse(
      (await privacy.downloadExport(contactId, dsr.id)).toString('utf8'),
    ) as { channels: { value_normalised: string }[]; consents: unknown[] };
    expect(data.channels.map((c) => c.value_normalised)).toContain(email);
    expect(data.consents).toHaveLength(1);

    // A stranger cannot download someone else's life.
    const stranger = await contacts.resolveOrProvision(`kc-${uuid()}`);
    await expect(privacy.downloadExport(stranger, dsr.id)).rejects.toMatchObject({
      response: { code: 'dsr_not_found' },
    });

    // The export itself is an audited PII action.
    const exportAudit = await db.kysely
      .selectFrom('audit.pii_access_log')
      .select('seq')
      .where('subject_contact_id', '=', contactId)
      .where('action', '=', 'export')
      .execute();
    expect(exportAudit.length).toBeGreaterThanOrEqual(1);
  });

  it('DSR escalates before the one-month deadline', async () => {
    const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const dsr = await privacy.fileDsr(contactId, 'access');
    const due = new Date(dsr.due_at);
    expect(due.getTime() - clock.now().getTime()).toBe(30 * DAY);

    clock.advance(26 * DAY); // escalation margin is due - 5 days
    await scheduler.drainDue();

    const row = await db.kysely
      .selectFrom('privacy.dsr')
      .select('state')
      .where('id', '=', dsr.id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('escalated');
    const event = await db.kysely
      .selectFrom('core.outbox_event')
      .select('id')
      .where('event_type', '=', 'dsr.escalated')
      .where('aggregate_id', '=', dsr.id)
      .execute();
    expect(event).toHaveLength(1);
  });

  it('retention sweep erases stale unregistered leads and purges old payloads, with purge_log evidence', async () => {
    // A scraped lead 200 days old (policy: 180) and a fresh one.
    const stale = await db.kysely
      .insertInto('core.contact')
      .values({
        lifecycle_state: 'unregistered',
        created_at: new Date(clock.now().getTime() - 200 * DAY),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const fresh = await db.kysely
      .insertInto('core.contact')
      .values({ lifecycle_state: 'unregistered' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const results = await privacy.runRetentionSweep();
    expect(results.unregistered_scraped_leads).toBeGreaterThanOrEqual(1);

    expect(
      (await db.kysely.selectFrom('core.contact').select('lifecycle_state')
        .where('id', '=', stale.id).executeTakeFirstOrThrow()).lifecycle_state,
    ).toBe('erased');
    expect(
      (await db.kysely.selectFrom('core.contact').select('lifecycle_state')
        .where('id', '=', fresh.id).executeTakeFirstOrThrow()).lifecycle_state,
    ).toBe('unregistered');

    const log = await db.kysely
      .selectFrom('privacy.purge_log')
      .selectAll()
      .where('data_category', '=', 'unregistered_scraped_leads')
      .orderBy('ran_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(log.purged_count).toBeGreaterThanOrEqual(1);
  });

  it('restriction freezes processing; consent withdrawal takes effect', async () => {
    const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    await privacy.applyRestriction(contactId, true);
    expect(
      (await db.kysely.selectFrom('core.contact').select('processing_restricted')
        .where('id', '=', contactId).executeTakeFirstOrThrow()).processing_restricted,
    ).toBe(true);

    await db.kysely
      .insertInto('privacy.consent')
      .values({ contact_id: contactId, purpose: 'marketing' })
      .execute();
    await privacy.withdrawConsent(contactId, 'marketing');
    const consents = (await privacy.listConsents(contactId)) as { withdrawn_at: Date | null }[];
    expect(consents[0].withdrawn_at).not.toBeNull();
  });
});
