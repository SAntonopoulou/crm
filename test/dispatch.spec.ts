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
  JOB_HOLD_EXPIRE,
} from '../src/modules/appointments/appointments.service';
import {
  DispatchService,
  JOB_DISPATCH_START,
  JOB_OFFER_TTL,
  ClaimResult,
} from '../src/modules/dispatch/dispatch.service';

const uuid = () => crypto.randomUUID();
const HOUR = 3_600_000;
const CLAIM_SOAK = Number(process.env.CLAIM_SOAK ?? 10);

describe('dispatch & attribution (#21)', () => {
  let db: Db;
  let clock: TestClock;
  let scheduler: InlineJobScheduler;
  let dispatch: DispatchService;
  let appointments: AppointmentsService;
  let agents: AgentsService;
  let contacts: ContactsService;

  // Isolated patch of the map per run so candidate ranking sees only ours.
  const baseLat = 49.6 + Math.random() * 0.3;
  const baseLng = 5.4 + Math.random() * 0.3;

  beforeAll(() => {
    const config = new ConfigService({ DISPATCH_STRATEGY: 'broadcast' });
    db = new Db(new ConfigService());
    clock = new TestClock(new Date('2026-09-01T08:00:00Z'));
    const registry = new JobRegistry();
    scheduler = new InlineJobScheduler(clock, registry);
    contacts = new ContactsService(db);
    agents = new AgentsService(db, clock);
    const pipelines = new PipelinesService(db, clock, scheduler, config);
    appointments = new AppointmentsService(db, clock, pipelines, scheduler, config);
    dispatch = new DispatchService(db, clock, appointments, scheduler, config);
    registry.register(JOB_HOLD_EXPIRE, (p) =>
      appointments.expireHold((p as { holdId: string }).holdId),
    );
    registry.register(JOB_DISPATCH_START, async (p) => {
      await dispatch.startDispatch((p as { appointmentId: string }).appointmentId);
    });
    registry.register(JOB_OFFER_TTL, (p) =>
      dispatch.expireOffer((p as { offerId: string }).offerId),
    );
    registry.register('notification.dispatch_offer', async () => {}); // real handler in notifications.spec
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  async function fixtureAgent(opts?: {
    dLat?: number;
    dLng?: number;
    radiusKm?: number;
  }): Promise<string> {
    const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    await agents.onboard(contactId);
    await agents.submitDocument(contactId, 'licence', `s3://${uuid()}`,
      new Date(clock.now().getTime() + 365 * 24 * HOUR));
    await agents.submitDocument(contactId, 'insurance', `s3://${uuid()}`,
      new Date(clock.now().getTime() + 365 * 24 * HOUR));
    await agents.acceptTerms(contactId);
    await agents.approve(contactId, uuid());
    // Coverage: small polygon around the agent's home point.
    const lat = baseLat + (opts?.dLat ?? 0);
    const lng = baseLng + (opts?.dLng ?? 0);
    const r = (opts?.radiusKm ?? 5) / 111; // ~degrees
    await db.kysely
      .insertInto('core.coverage_area')
      .values({
        agent_id: contactId,
        area: sql`ST_GeomFromGeoJSON(${JSON.stringify({
          type: 'MultiPolygon',
          coordinates: [[[
            [lng - r, lat - r], [lng + r, lat - r], [lng + r, lat + r],
            [lng - r, lat + r], [lng - r, lat - r],
          ]]],
        })})::geography`,
      })
      .execute();
    return contactId;
  }

  async function fixtureDispatchingAppointment(opts?: {
    dLat?: number;
    dLng?: number;
  }): Promise<{ appointmentId: string; viewerId: string; propertyId: string }> {
    const prop = await db.kysely
      .insertInto('core.property')
      .values({
        canonical_key: `disp-${uuid()}`,
        address_normalised: JSON.stringify({ city: 'aarlen', postcode: '6700' }),
        kind: 'apartment',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await sql`UPDATE core.property SET geo_point = ST_SetSRID(ST_MakePoint(${baseLng + (opts?.dLng ?? 0)}, ${baseLat + (opts?.dLat ?? 0)}), 4326)::geography WHERE id = ${prop.id}`.execute(db.kysely);
    const listing = await db.kysely
      .insertInto('core.listing')
      .values({ property_id: prop.id, channel: 'sale', state: 'live', price: '250000.00' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const viewerId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const start = new Date(clock.now().getTime() + 72 * HOUR);
    const appointment = await db.kysely
      .insertInto('core.appointment')
      .values({
        property_id: prop.id,
        listing_id: listing.id,
        viewer_contact_id: viewerId,
        during: sql`tstzrange(${start}, ${new Date(start.getTime() + HOUR)})`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { appointmentId: appointment.id, viewerId, propertyId: prop.id };
  }

  async function offersOf(dispatchId: string) {
    return db.kysely
      .selectFrom('core.dispatch_offer')
      .selectAll()
      .where('dispatch_id', '=', dispatchId)
      .orderBy('created_at')
      .execute();
  }

  it(`MANDATED: concurrent claim — exactly one winner, ${CLAIM_SOAK} iterations`, async () => {
    for (let round = 0; round < CLAIM_SOAK; round++) {
      await Promise.all(Array.from({ length: 8 }, () => fixtureAgent()));
      const { appointmentId } = await fixtureDispatchingAppointment();
      const dispatchId = (await dispatch.startDispatch(appointmentId))!;
      const offers = await offersOf(dispatchId);
      expect(offers.length).toBe(8);

      // Barrier: fire all eight claims in the same tick.
      const results = await Promise.allSettled(
        offers.map((o) => dispatch.claim(o.id, o.agent_id)),
      );

      const wins = results.filter((r) => r.status === 'fulfilled');
      const losses = results.filter(
        (r) =>
          r.status === 'rejected' &&
          (r.reason as { response?: { code?: string } }).response?.code ===
            'already_claimed',
      );
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(7);

      const winner = (wins[0] as PromiseFulfilledResult<ClaimResult>).value;

      // Idempotent replay: the winner retries after a network failure.
      const winningOffer = await db.kysely
        .selectFrom('core.dispatch_offer')
        .selectAll()
        .where('dispatch_id', '=', dispatchId)
        .where('state', '=', 'claimed')
        .executeTakeFirstOrThrow();
      const replay = await dispatch.claim(winningOffer.id, winningOffer.agent_id);
      expect(replay.agreement.id).toBe(winner.agreement.id);

      // Exactly one of everything; all siblings withdrawn.
      const agreements = await db.kysely
        .selectFrom('core.assignment_agreement')
        .select(db.kysely.fn.countAll().as('n'))
        .where('appointment_id', '=', appointmentId)
        .executeTakeFirstOrThrow();
      expect(Number(agreements.n)).toBe(1);
      const grants = await db.kysely
        .selectFrom('core.access_grant')
        .select(db.kysely.fn.countAll().as('n'))
        .where('appointment_id', '=', appointmentId)
        .executeTakeFirstOrThrow();
      expect(Number(grants.n)).toBe(1);
      const states = await offersOf(dispatchId);
      expect(states.filter((o) => o.state === 'claimed')).toHaveLength(1);
      expect(states.filter((o) => o.state === 'withdrawn')).toHaveLength(7);
      const appt = await db.kysely
        .selectFrom('core.appointment')
        .select(['state', 'agent_id'])
        .where('id', '=', appointmentId)
        .executeTakeFirstOrThrow();
      expect(appt.state).toBe('booked');
      // The assigned agent is exactly the one whose offer won the race.
      expect(appt.agent_id).toBe(
        states.find((o) => o.state === 'claimed')!.agent_id,
      );
      const claimedEvents = await db.kysely
        .selectFrom('core.outbox_event')
        .select(db.kysely.fn.countAll().as('n'))
        .where('event_type', '=', 'dispatch.claimed')
        .where('aggregate_id', '=', dispatchId)
        .executeTakeFirstOrThrow();
      expect(Number(claimedEvents.n)).toBe(1);
    }
  }, 120_000);

  it('claim carries exclusivity (start + 30 days), attribution, touch and the reveal window', async () => {
    await fixtureAgent();
    const { appointmentId, viewerId, propertyId } = await fixtureDispatchingAppointment();
    const dispatchId = (await dispatch.startDispatch(appointmentId))!;
    const [offer] = await offersOf(dispatchId);
    const result = await dispatch.claim(offer.id, offer.agent_id);

    const appointmentStart = await db.kysely
      .selectFrom('core.appointment')
      .select(sql<Date>`lower(during)`.as('starts_at'))
      .where('id', '=', appointmentId)
      .executeTakeFirstOrThrow();
    const expectedEnd = new Date(
      appointmentStart.starts_at.getTime() + 30 * 24 * HOUR,
    );
    expect(result.agreement.exclusivity_ends_at).toBe(expectedEnd.toISOString());

    const attribution = await db.kysely
      .selectFrom('core.attribution')
      .selectAll()
      .where('buyer_contact_id', '=', viewerId)
      .where('property_id', '=', propertyId)
      .executeTakeFirstOrThrow();
    expect(attribution.state).toBe('active');

    const touch = await db.kysely
      .selectFrom('core.lead_touch')
      .selectAll()
      .where('buyer_contact_id', '=', viewerId)
      .where('kind', '=', 'claim')
      .execute();
    expect(touch).toHaveLength(1);

    // Reveal window: appointment ± buffers (1h before, 24h after).
    const grant = await db.kysely
      .selectFrom('core.access_grant')
      .select([
        sql<Date>`lower(during)`.as('from'),
        sql<Date>`upper(during)`.as('to'),
      ])
      .where('appointment_id', '=', appointmentId)
      .executeTakeFirstOrThrow();
    expect(grant.from.getTime()).toBe(appointmentStart.starts_at.getTime() - HOUR);
    expect(new Date(result.contact_reveal_window_ends_at).getTime()).toBe(
      grant.to.getTime(),
    );
  });

  it('expired and withdrawn offers claim cleanly negative', async () => {
    await Promise.all([fixtureAgent(), fixtureAgent()]);
    const { appointmentId } = await fixtureDispatchingAppointment();
    const dispatchId = (await dispatch.startDispatch(appointmentId))!;
    const offers = await offersOf(dispatchId);

    // First offer expires via TTL.
    clock.advance(121_000);
    await scheduler.drainDue();
    await expect(
      dispatch.claim(offers[0].id, offers[0].agent_id),
    ).rejects.toMatchObject({ response: { code: 'offer_expired' } });
  });

  it('waterfall: decline advances to the next candidate; exhaustion widens then gives up', async () => {
    const config = new ConfigService({ DISPATCH_STRATEGY: 'waterfall' });
    const waterfall = new DispatchService(db, clock, appointments, scheduler, config);

    const near = await fixtureAgent({ dLng: 0.55, dLat: 0 });
    // ~19 km east: outside the 10 km initial ring, inside the 20 km rung-1 ring.
    const far = await fixtureAgent({ dLng: 0.55 + 0.25, dLat: 0 });
    // The database persists across runs — remove every other active agent so
    // the candidate rings contain exactly our two fixtures.
    await db.kysely
      .updateTable('core.agent_profile')
      .set({ state: 'offboarded' })
      .where('state', '=', 'active')
      .where('contact_id', 'not in', [near, far])
      .execute();
    const { appointmentId } = await fixtureDispatchingAppointment({ dLng: 0.55 });
    const dispatchId = (await waterfall.startDispatch(appointmentId))!;

    // Round 1: only the near agent is inside the 10 km ring, one offer out.
    let offers = await offersOf(dispatchId);
    expect(offers).toHaveLength(1);
    expect(offers[0].agent_id).toBe(near);

    await waterfall.decline(offers[0].id, near);

    // Decline exhausts the ring → escalation widens to 20 km → far agent.
    offers = await offersOf(dispatchId);
    expect(offers).toHaveLength(2);
    const farOffer = offers.find((o) => o.agent_id === far)!;
    expect(farOffer.state).toBe('sent');

    // Far agent lets it expire; no rings left → no_agent + unstaffed.
    clock.advance(121_000);
    await scheduler.drainDue();

    const finalDispatch = await db.kysely
      .selectFrom('core.dispatch')
      .select(['state', 'escalation_rung'])
      .where('id', '=', dispatchId)
      .executeTakeFirstOrThrow();
    expect(finalDispatch.state).toBe('no_agent');
    const appt = await db.kysely
      .selectFrom('core.appointment')
      .select('state')
      .where('id', '=', appointmentId)
      .executeTakeFirstOrThrow();
    expect(appt.state).toBe('unstaffed');
    const noAgentEvent = await db.kysely
      .selectFrom('core.outbox_event')
      .select('id')
      .where('event_type', '=', 'dispatch.no_agent')
      .where('aggregate_id', '=', dispatchId)
      .execute();
    expect(noAgentEvent).toHaveLength(1);
  });

  it('every candidate is persisted with score components (Art 22 trail)', async () => {
    await Promise.all([fixtureAgent(), fixtureAgent(), fixtureAgent()]);
    const { appointmentId } = await fixtureDispatchingAppointment();
    const dispatchId = (await dispatch.startDispatch(appointmentId))!;

    const candidates = await db.kysely
      .selectFrom('core.dispatch_candidate')
      .selectAll()
      .where('dispatch_id', '=', dispatchId)
      .orderBy('rank')
      .execute();
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    for (const c of candidates) {
      const components = c.score_components as Record<string, number>;
      expect(Object.keys(components).sort()).toEqual(
        ['distance', 'fairness', 'language', 'load', 'rating'],
      );
    }
    // Ranks are dense from 1.
    expect(candidates.map((c) => c.rank)).toEqual(
      candidates.map((_, i) => i + 1),
    );
  });
});
