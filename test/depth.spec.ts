import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { Db } from '../src/shared/database/db.service';
import { TestClock } from '../src/shared/jobs/clock';
import { InlineJobScheduler, JobRegistry } from '../src/shared/jobs/job-scheduler';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { AgentsService } from '../src/modules/agents/agents.service';
import { PipelinesService } from '../src/modules/pipelines/pipelines.service';
import {
  AppointmentsService,
} from '../src/modules/appointments/appointments.service';
import {
  DispatchService,
  JOB_AGENT_WITHDRAW,
  JOB_APPOINTMENT_REMINDER,
  JOB_DISPATCH_START,
  JOB_OFFER_TTL,
} from '../src/modules/dispatch/dispatch.service';

const uuid = () => crypto.randomUUID();
const HOUR = 3_600_000;

describe('product depth: reminders, re-dispatch, waitlist, scorecard (#36–38)', () => {
  let db: Db;
  let clock: TestClock;
  let scheduler: InlineJobScheduler;
  let dispatch: DispatchService;
  let appointments: AppointmentsService;
  let contacts: ContactsService;
  let agents: AgentsService;
  const sentNotifications: { contactId: string; kind: string }[] = [];

  const baseLat = 48.6 + Math.random() * 0.2;
  const baseLng = 6.1 + Math.random() * 0.2;

  beforeAll(() => {
    const config = new ConfigService({ DISPATCH_STRATEGY: 'broadcast' });
    db = new Db(new ConfigService());
    clock = new TestClock(new Date('2026-08-16T08:00:00Z'));
    const registry = new JobRegistry();
    scheduler = new InlineJobScheduler(clock, registry);
    contacts = new ContactsService(db);
    agents = new AgentsService(db, clock);
    const pipelines = new PipelinesService(db, clock, scheduler, config);
    appointments = new AppointmentsService(db, clock, pipelines, scheduler, config);
    dispatch = new DispatchService(db, clock, appointments, scheduler, config);
    registry.register(JOB_DISPATCH_START, async (p) => {
      await dispatch.startDispatch((p as { appointmentId: string }).appointmentId);
    });
    registry.register(JOB_OFFER_TTL, (p) =>
      dispatch.expireOffer((p as { offerId: string }).offerId),
    );
    registry.register(JOB_AGENT_WITHDRAW, async (p) => {
      const payload = p as { appointmentId: string; reason: 'cancelled' | 'no_show' };
      await dispatch.agentWithdraw(payload.appointmentId, payload.reason);
    });
    registry.register(JOB_APPOINTMENT_REMINDER, (p) => {
      const payload = p as { appointmentId: string; offset: '24h' | '2h' };
      return dispatch.sendReminder(payload.appointmentId, payload.offset);
    });
    registry.register('notification.send', async (p) => {
      const payload = p as { contactId: string; kind: string };
      sentNotifications.push({ contactId: payload.contactId, kind: payload.kind });
    });
    registry.register('notification.dispatch_offer', async () => {});
    registry.register('calendar.push_event', async () => {});
    registry.register('calendar.remove_event', async () => {});
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  async function fixtureAgent(): Promise<string> {
    const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    await agents.onboard(contactId);
    await agents.submitDocument(contactId, 'licence', `s3://${uuid()}`,
      new Date(clock.now().getTime() + 365 * 24 * HOUR));
    await agents.submitDocument(contactId, 'insurance', `s3://${uuid()}`,
      new Date(clock.now().getTime() + 365 * 24 * HOUR));
    await agents.acceptTerms(contactId);
    await agents.approve(contactId, uuid());
    const r = 0.05;
    await db.kysely
      .insertInto('core.coverage_area')
      .values({
        agent_id: contactId,
        area: sql`ST_GeomFromGeoJSON(${JSON.stringify({
          type: 'MultiPolygon',
          coordinates: [[[
            [baseLng - r, baseLat - r], [baseLng + r, baseLat - r],
            [baseLng + r, baseLat + r], [baseLng - r, baseLat + r],
            [baseLng - r, baseLat - r],
          ]]],
        })})::geography`,
      })
      .execute();
    return contactId;
  }

  async function fixtureAppointment(opts?: { kind?: string; capacity?: number }) {
    const prop = await db.kysely
      .insertInto('core.property')
      .values({
        canonical_key: `depth-${uuid()}`,
        address_normalised: JSON.stringify({ city: 'aarlen', postcode: '6700' }),
        kind: 'apartment',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await sql`UPDATE core.property SET geo_point = ST_SetSRID(ST_MakePoint(${baseLng}, ${baseLat}), 4326)::geography WHERE id = ${prop.id}`.execute(db.kysely);
    const listing = await db.kysely
      .insertInto('core.listing')
      .values({ property_id: prop.id, channel: 'sale', state: 'live', price: '200000.00' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const viewer = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const start = new Date(clock.now().getTime() + 72 * HOUR);
    const appointment = await db.kysely
      .insertInto('core.appointment')
      .values({
        property_id: prop.id,
        listing_id: listing.id,
        viewer_contact_id: viewer,
        kind: opts?.kind ?? 'private',
        capacity: opts?.capacity ?? null,
        during: sql`tstzrange(${start}, ${new Date(start.getTime() + HOUR)})`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { appointmentId: appointment.id, viewer, start };
  }

  it('#36: claim arms T-24h/T-2h reminders that notify both parties', async () => {
    await fixtureAgent();
    const { appointmentId, viewer, start } = await fixtureAppointment();
    const dispatchId = (await dispatch.startDispatch(appointmentId))!;
    const offer = await db.kysely
      .selectFrom('core.dispatch_offer')
      .selectAll()
      .where('dispatch_id', '=', dispatchId)
      .executeTakeFirstOrThrow();
    await dispatch.claim(offer.id, offer.agent_id);

    sentNotifications.length = 0;
    clock.set(new Date(start.getTime() - 23 * HOUR)); // past T-24h
    // Drain to quiescence: the reminder job enqueues notification.send jobs.
    while ((await scheduler.drainDue()) > 0) { /* keep draining */ }

    const reminded = sentNotifications.filter((n) => n.kind === 'viewing_reminder');
    expect(reminded.map((n) => n.contactId).sort()).toEqual(
      [viewer, offer.agent_id].sort(),
    );
    const event = await db.kysely
      .selectFrom('core.outbox_event')
      .selectAll()
      .where('event_type', '=', 'appointment.reminder_due')
      .where('aggregate_id', '=', appointmentId)
      .execute();
    expect(event).toHaveLength(1);
  });

  it('#36: agent withdrawal pre-viewing revokes grant + attribution and re-dispatches', async () => {
    const [first, second] = [await fixtureAgent(), await fixtureAgent()];
    const { appointmentId } = await fixtureAppointment();
    const dispatchId = (await dispatch.startDispatch(appointmentId))!;
    const offers = await db.kysely
      .selectFrom('core.dispatch_offer')
      .selectAll()
      .where('dispatch_id', '=', dispatchId)
      .execute();
    // Claim with whichever agent got an offer first.
    const claimedOffer = offers.find((o) => [first, second].includes(o.agent_id)) ?? offers[0];
    await dispatch.claim(claimedOffer.id, claimedOffer.agent_id);

    const result = await dispatch.agentWithdraw(appointmentId, 'cancelled');
    expect(result).toBe('redispatched');

    const appt = await db.kysely
      .selectFrom('core.appointment')
      .select(['state', 'agent_id'])
      .where('id', '=', appointmentId)
      .executeTakeFirstOrThrow();
    expect(appt.state).toBe('dispatching');
    expect(appt.agent_id).toBeNull();

    const grant = await db.kysely
      .selectFrom('core.access_grant')
      .select('revoked_at')
      .where('appointment_id', '=', appointmentId)
      .executeTakeFirstOrThrow();
    expect(grant.revoked_at).not.toBeNull();

    // A fresh dispatch is live for the same appointment.
    const dispatches = await db.kysely
      .selectFrom('core.dispatch')
      .select(['id', 'state'])
      .where('appointment_id', '=', appointmentId)
      .orderBy('created_at')
      .execute();
    expect(dispatches.length).toBeGreaterThanOrEqual(2);
    expect(dispatches.at(-1)!.state).toBe('offering');
  });

  it('#37: open-house capacity confirms in order and promotes on unregister', async () => {
    const { appointmentId } = await fixtureAppointment({ kind: 'open_house', capacity: 2 });
    const [a, b, c] = await Promise.all([
      contacts.resolveOrProvision(`kc-${uuid()}`),
      contacts.resolveOrProvision(`kc-${uuid()}`),
      contacts.resolveOrProvision(`kc-${uuid()}`),
    ]);

    expect(await appointments.registerForOpenHouse(appointmentId, a)).toEqual(
      { position: 1, confirmed: true },
    );
    expect(await appointments.registerForOpenHouse(appointmentId, b)).toEqual(
      { position: 2, confirmed: true },
    );
    expect(await appointments.registerForOpenHouse(appointmentId, c)).toEqual(
      { position: 3, confirmed: false }, // waitlisted
    );
    // Idempotent re-registration keeps the position.
    expect(await appointments.registerForOpenHouse(appointmentId, a)).toEqual(
      { position: 1, confirmed: true },
    );

    sentNotifications.length = 0;
    await appointments.unregisterFromOpenHouse(appointmentId, a);
    await scheduler.drainDue();
    expect(sentNotifications).toEqual([
      { contactId: c, kind: 'open_house_promoted' },
    ]);
  });

  it('#38: scorecard refresh feeds real ratings into candidate ranking', async () => {
    const good = await fixtureAgent();
    // History: one claimed offer for `good` (via a real claim above happens in
    // other tests; make one deterministic here) and an agent no-show for `bad`.
    const bad = await fixtureAgent();
    const fixture = await fixtureAppointment();
    await db.kysely
      .updateTable('core.appointment')
      .set({ agent_id: bad, state: 'no_show', cancelled_by: 'agent' })
      .where('id', '=', fixture.appointmentId)
      .execute();

    await agents.refreshScorecard();

    const scorecard = await sql<{ agent_id: string; score: string }>`
      SELECT agent_id, score::text FROM core.agent_scorecard
       WHERE agent_id IN (${good}, ${bad})
    `.execute(db.kysely);
    const scores = new Map(scorecard.rows.map((r) => [r.agent_id, Number(r.score)]));
    expect(scores.get(bad)).toBeLessThan(scores.get(good)!);

    // Ranking picks the score up (bad agent's rating component < good's).
    const { appointmentId } = await fixtureAppointment();
    const dispatchId = (await dispatch.startDispatch(appointmentId))!;
    const candidates = await db.kysely
      .selectFrom('core.dispatch_candidate')
      .selectAll()
      .where('dispatch_id', '=', dispatchId)
      .where('agent_id', 'in', [good, bad])
      .execute();
    const componentOf = (id: string) =>
      (candidates.find((c) => c.agent_id === id)?.score_components as { rating: number })
        .rating;
    expect(componentOf(bad)).toBeLessThan(componentOf(good));
  });
});
