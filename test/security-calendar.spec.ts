import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { AuditLog } from '../src/shared/audit/audit-log.service';
import { Db } from '../src/shared/database/db.service';
import { TestClock } from '../src/shared/jobs/clock';
import { InlineJobScheduler, JobRegistry } from '../src/shared/jobs/job-scheduler';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { LocalDiskStorage } from '../src/modules/platform/media.service';
import { IdpAdminPort } from '../src/modules/privacy/privacy.service';
import { SecurityService } from '../src/modules/privacy/security.service';
import {
  BreachService,
  breachMachine,
  JOB_BREACH_WARNING,
} from '../src/modules/privacy/breach.service';
import {
  CalendarService,
  CalendarSyncPort,
  CalendarLinkRow,
  CalendarEvent,
} from '../src/modules/calendar/calendar.service';

const uuid = () => crypto.randomUUID();
const HOUR = 3_600_000;

class FakeIdp extends IdpAdminPort {
  sessionsRevoked: string[] = [];
  async deleteSubject(): Promise<void> {}
  async revokeSubjectSessions(subjectId: string): Promise<void> {
    this.sessionsRevoked.push(subjectId);
  }
}

class FakeCalendar extends CalendarSyncPort {
  pushed: { linkId: string; event: CalendarEvent }[] = [];
  deleted: string[] = [];
  busy: { start: Date; end: Date }[] = [];
  async pushEvent(link: CalendarLinkRow, event: CalendarEvent): Promise<string | null> {
    this.pushed.push({ linkId: link.id, event });
    return `ext-${event.id}`;
  }
  async deleteEvent(_link: CalendarLinkRow, externalEventId: string): Promise<void> {
    this.deleted.push(externalEventId);
  }
  async listBusy(): Promise<{ start: Date; end: Date }[]> {
    return this.busy;
  }
}

describe('calendar port, recovery/export controls, breach tooling (#41–43)', () => {
  let db: Db;
  let clock: TestClock;
  let scheduler: InlineJobScheduler;
  let registry: JobRegistry;
  let security: SecurityService;
  let breach: BreachService;
  let calendar: CalendarService;
  let calendarPort: FakeCalendar;
  let idp: FakeIdp;
  let contacts: ContactsService;
  const sentNotifications: { contactId: string; kind: string }[] = [];

  beforeAll(() => {
    db = new Db(new ConfigService());
    clock = new TestClock(new Date('2026-08-17T09:00:00Z'));
    registry = new JobRegistry();
    scheduler = new InlineJobScheduler(clock, registry);
    contacts = new ContactsService(db);
    idp = new FakeIdp();
    const storage = new LocalDiskStorage(
      new ConfigService({ MEDIA_STORAGE_DIR: 'var/test-uploads' }),
    );
    security = new SecurityService(db, clock, new AuditLog(db), idp, storage);
    breach = new BreachService(db, clock, scheduler);
    calendarPort = new FakeCalendar();
    calendar = new CalendarService(db, clock, calendarPort);
    registry.register(JOB_BREACH_WARNING, (p) =>
      breach.deadlineWarning((p as { incidentId: string }).incidentId),
    );
    registry.register('notification.send', async (p) => {
      const payload = p as { contactId: string; kind: string };
      sentNotifications.push({ contactId: payload.contactId, kind: payload.kind });
    });
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  async function agentWithLink(): Promise<{ agentId: string; linkId: string }> {
    const agentId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    await db.kysely
      .insertInto('core.agent_profile')
      .values({ contact_id: agentId, state: 'active' })
      .execute();
    const link = await db.kysely
      .insertInto('core.calendar_link')
      .values({ agent_id: agentId, provider: 'google' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { agentId, linkId: link.id };
  }

  it('#41: claim-side push mirrors the viewing; withdrawal removes it; busy import creates absences', async () => {
    const { agentId, linkId } = await agentWithLink();
    const prop = await db.kysely
      .insertInto('core.property')
      .values({
        canonical_key: `cal-${uuid()}`,
        address_normalised: JSON.stringify({ postcode: '1000', city: 'brussel' }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const listing = await db.kysely
      .insertInto('core.listing')
      .values({ property_id: prop.id, channel: 'sale' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const viewer = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const start = new Date(clock.now().getTime() + 48 * HOUR);
    const appointment = await db.kysely
      .insertInto('core.appointment')
      .values({
        property_id: prop.id,
        listing_id: listing.id,
        viewer_contact_id: viewer,
        agent_id: agentId,
        state: 'booked',
        during: sql`tstzrange(${start}, ${new Date(start.getTime() + HOUR)})`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await calendar.pushAppointment(appointment.id, agentId);
    expect(calendarPort.pushed).toHaveLength(1);
    expect(calendarPort.pushed[0].event.title).toContain('1000 brussel');
    const eventLink = await db.kysely
      .selectFrom('core.calendar_event_link')
      .selectAll()
      .where('appointment_id', '=', appointment.id)
      .executeTakeFirstOrThrow();
    expect(eventLink.external_event_id).toBe(`ext-${appointment.id}`);

    await calendar.removeAppointment(appointment.id);
    expect(calendarPort.deleted).toEqual([`ext-${appointment.id}`]);

    // External busy windows become absences the ranking already excludes.
    calendarPort.busy = [
      { start: new Date(clock.now().getTime() + 5 * HOUR),
        end: new Date(clock.now().getTime() + 7 * HOUR) },
    ];
    expect(await calendar.importBusy(linkId)).toBe(1);
    const absences = await db.kysely
      .selectFrom('core.agent_absence')
      .selectAll()
      .where('agent_id', '=', agentId)
      .where('reason', '=', 'external_calendar')
      .execute();
    expect(absences).toHaveLength(1);
    // Re-import replaces rather than accumulates.
    expect(await calendar.importBusy(linkId)).toBe(1);
    expect(
      (await db.kysely
        .selectFrom('core.agent_absence')
        .select(db.kysely.fn.countAll().as('n'))
        .where('agent_id', '=', agentId)
        .where('reason', '=', 'external_calendar')
        .executeTakeFirstOrThrow()).n,
    ).toBe('1');
  });

  it('#42: recovery needs two DIFFERENT approvers, completion arms the payout cooldown', async () => {
    const subject = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const [staffA, staffB] = [uuid(), uuid()];

    const recoveryId = await security.openRecovery(subject, 'lost phone + email', staffA);
    expect(await security.approveRecovery(recoveryId, staffA)).toBe('first_approved');
    await expect(security.approveRecovery(recoveryId, staffA)).rejects.toMatchObject({
      response: { code: 'same_approver' },
    });
    expect(await security.approveRecovery(recoveryId, staffB)).toBe('approved');

    const unlockedAt = await security.completeRecovery(recoveryId, staffB);
    expect(unlockedAt.getTime()).toBe(clock.now().getTime() + 72 * HOUR);
    expect(await security.payoutChangeAllowed(subject)).toBe(false);
    clock.advance(73 * HOUR);
    expect(await security.payoutChangeAllowed(subject)).toBe(true);
  });

  it('#42: bulk export needs a second approver and embeds the watermark; sessions revoke via the port', async () => {
    const [requester, approver] = [uuid(), uuid()];
    const exportId = await security.requestExport(requester, { entity: 'agents' });

    await expect(security.approveExport(exportId, requester)).rejects.toMatchObject({
      response: { code: 'same_approver' },
    });
    await expect(security.deliverExport(exportId, requester)).rejects.toMatchObject({
      response: { code: 'not_approved' },
    });
    await security.approveExport(exportId, approver);
    const storageKey = await security.deliverExport(exportId, requester);

    const request = await db.kysely
      .selectFrom('core.export_request')
      .selectAll()
      .where('id', '=', exportId)
      .executeTakeFirstOrThrow();
    expect(request.state).toBe('delivered');
    const file = JSON.parse(
      (await new LocalDiskStorage(
        new ConfigService({ MEDIA_STORAGE_DIR: 'var/test-uploads' }),
      ).get(storageKey)).toString('utf8'),
    ) as { watermark: string; records: { _watermark: string }[] };
    expect(file.watermark).toBe(request.watermark_id);
    expect(file.records.every((r) => r._watermark === request.watermark_id)).toBe(true);

    // Session revocation reaches the IdP with the subject id.
    const contactId = await contacts.resolveOrProvision(`kc-sess-${uuid()}`);
    await security.revokeSessions(contactId, approver);
    expect(idp.sessionsRevoked).toHaveLength(1);
  });

  it('#43: breach clock warns at T-12h, machine guards transitions, subjects get notices', async () => {
    const staffId = uuid();
    const incident = await breach.openIncident(staffId, 'suspicious export pattern detected');
    const deadline = new Date(incident.notify_deadline_at);
    expect(deadline.getTime()).toBe(clock.now().getTime() + 72 * HOUR);

    // Illegal jump: triage → notified_subjects.
    await expect(
      breach.transition(incident.id, 'notified_subjects', staffId, 'skip'),
    ).rejects.toThrow(/illegal breach transition/);

    // T-12h with the DPA still un-notified → warning task + event.
    clock.set(new Date(deadline.getTime() - 11 * HOUR));
    await scheduler.drainDue();
    const task = await db.kysely
      .selectFrom('core.task')
      .selectAll()
      .where('kind', '=', 'breach_deadline_warning')
      .execute();
    expect(task.length).toBeGreaterThanOrEqual(1);

    await breach.transition(incident.id, 'assessing', staffId, 'scope confirmed: 12 subjects');
    await breach.transition(incident.id, 'notified_dpa', staffId, 'APD notified, ref BE-2026-041');

    sentNotifications.length = 0;
    const subjects = [
      await contacts.resolveOrProvision(`kc-${uuid()}`),
      await contacts.resolveOrProvision(`kc-${uuid()}`),
    ];
    await breach.notifySubjects(incident.id, subjects, staffId, 'contact channels exposed');
    while ((await scheduler.drainDue()) > 0) { /* drain notification jobs */ }
    expect(sentNotifications.filter((n) => n.kind === 'breach_notice')).toHaveLength(2);

    const row = await db.kysely
      .selectFrom('privacy.breach_incident')
      .selectAll()
      .where('id', '=', incident.id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('notified_subjects');
    const timeline = row.timeline as { state: string; note: string }[];
    expect(timeline.length).toBeGreaterThanOrEqual(4); // open + 3 transitions
    expect(timeline.at(-1)!.note).toContain('2 subjects');

    // A DPA-notified incident never re-warns.
    await breach.deadlineWarning(incident.id);
    expect(
      (await db.kysely
        .selectFrom('core.task')
        .select(db.kysely.fn.countAll().as('n'))
        .where('kind', '=', 'breach_deadline_warning')
        .executeTakeFirstOrThrow()).n,
    ).toBe(task.length.toString());
  });

  it('breach machine shape', () => {
    expect(breachMachine.can('triage', 'assessing')).toBe(true);
    expect(breachMachine.can('triage', 'closed')).toBe(true); // false alarm
    expect(breachMachine.can('notified_dpa', 'notified_subjects')).toBe(true);
    expect(breachMachine.can('closed', 'assessing')).toBe(false);
  });
});
