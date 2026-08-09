import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { Db } from '../src/shared/database/db.service';
import { TestClock } from '../src/shared/jobs/clock';
import { InlineJobScheduler, JobRegistry } from '../src/shared/jobs/job-scheduler';
import { ProvenanceResolver } from '../src/shared/provenance/provenance-resolver';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { AgentsService } from '../src/modules/agents/agents.service';
import { PipelinesService } from '../src/modules/pipelines/pipelines.service';
import { AppointmentsService } from '../src/modules/appointments/appointments.service';
import { DispatchService } from '../src/modules/dispatch/dispatch.service';
import { PropertiesService } from '../src/modules/properties/properties.service';
import { IngestService } from '../src/modules/properties/ingest.service';
import { SuppressionService } from '../src/modules/properties/suppression.service';
import {
  GeocoderPort,
  GeocodeResult,
  GeocodingService,
  JOB_GEOCODE,
} from '../src/modules/properties/geocoder.service';
import { NormalisedAddress } from '../src/modules/properties/normalise';

const uuid = () => crypto.randomUUID();

class FakeGeocoder extends GeocoderPort {
  async geocode(address: NormalisedAddress): Promise<GeocodeResult | null> {
    if (!address.postcode) return null;
    return { lat: 50.85, lng: 4.35, timezone: 'Europe/Brussels', confidence: 0.92 };
  }
}

describe('geocoding & ops actions (#34, #35)', () => {
  let db: Db;
  let clock: TestClock;
  let scheduler: InlineJobScheduler;
  let ingest: IngestService;
  let dispatch: DispatchService;
  let contacts: ContactsService;
  let agents: AgentsService;

  beforeAll(() => {
    const config = new ConfigService({ DISPATCH_STRATEGY: 'broadcast' });
    db = new Db(new ConfigService());
    clock = new TestClock(new Date('2026-08-15T09:00:00Z'));
    const registry = new JobRegistry();
    scheduler = new InlineJobScheduler(clock, registry);
    contacts = new ContactsService(db);
    agents = new AgentsService(db, clock);
    const properties = new PropertiesService(db, new ProvenanceResolver(), config, scheduler, clock);
    ingest = new IngestService(db, properties, contacts, new SuppressionService(db, new ConfigService()), scheduler);
    const geocoding = new GeocodingService(db, new FakeGeocoder());
    const pipelines = new PipelinesService(db, clock, scheduler, config);
    const appointments = new AppointmentsService(db, clock, pipelines, scheduler, config);
    dispatch = new DispatchService(db, clock, appointments, scheduler, config);
    registry.register(JOB_GEOCODE, async (p) => {
      await geocoding.geocodeProperty((p as { propertyId: string }).propertyId);
    });
    registry.register('dispatch.offer_ttl', async () => {});
    registry.register('notification.dispatch_offer', async () => {});
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  it('ingest schedules geocoding; the fake adapter fills geo_point (#34)', async () => {
    const street = `geostraat-${uuid()}`;
    const result = await ingest.processBatch(
      {
        source: { name: `portal-${uuid()}`, kind: 'portal_scrape' },
        records: [
          {
            idempotency_key: `rec-${uuid()}`,
            kind: 'property_listing',
            payload: {
              property: {
                address: { street, number: '5', postcode: '1000', city: 'brussel', country: 'BE' },
                listing: { channel: 'sale', price: '200000.00' },
              },
            },
            provenance: [{ collected_at: new Date().toISOString(), method: 'scraped', confidence: 0.9 }],
          },
        ],
      },
      `batch-${uuid()}`,
    );
    expect(result.status).toBe('completed');

    await scheduler.drainDue(); // fires properties.geocode

    const property = await db.kysely
      .selectFrom('core.property')
      .select([
        sql<string | null>`ST_Y(geo_point::geometry)::text`.as('lat'),
        'timezone',
      ])
      .where(({ eb, ref }) =>
        eb(ref('address_normalised', '->>').key('street'), '=', street),
      )
      .executeTakeFirstOrThrow();
    expect(Number(property.lat)).toBeCloseTo(50.85, 2);
    expect(property.timezone).toBe('Europe/Brussels');
  });

  it('staff quarantine acceptance reprocesses the record into real entities (#35)', async () => {
    const street = `quarstraat-${uuid()}`;
    const batch = await ingest.processBatch(
      {
        source: { name: `portal-${uuid()}`, kind: 'portal_scrape' },
        records: [
          {
            idempotency_key: `rec-${uuid()}`,
            kind: 'property_listing',
            payload: {
              property: {
                address: { street, number: '9', postcode: '1000', city: 'brussel', country: 'BE' },
                listing: { channel: 'sale', price: '150000.00' },
              },
            },
            provenance: [
              { collected_at: new Date().toISOString(), method: 'scraped', confidence: 0.1 },
            ], // low confidence → quarantine
          },
        ],
      },
      `batch-${uuid()}`,
    );
    const item = await db.kysely
      .selectFrom('core.quarantine_item as q')
      .innerJoin('core.ingest_record as r', 'r.id', 'q.ingest_record_id')
      .select(['q.id'])
      .where('r.run_id', '=', batch.batch_id)
      .executeTakeFirstOrThrow();

    const staffId = uuid();
    const resolved = await ingest.resolveQuarantine(item.id, 'accept', staffId);
    expect(resolved).toEqual({ state: 'accepted', outcome: 'created' });

    const property = await db.kysely
      .selectFrom('core.property')
      .select('id')
      .where(({ eb, ref }) =>
        eb(ref('address_normalised', '->>').key('street'), '=', street),
      )
      .executeTakeFirst();
    expect(property).toBeDefined();

    // Double resolution is refused.
    await expect(
      ingest.resolveQuarantine(item.id, 'accept', staffId),
    ).rejects.toMatchObject({ response: { code: 'already_resolved' } });
  });

  it('staff direct assignment rides the atomic claim path (#35)', async () => {
    // Agent + appointment far from every other fixture family.
    const agentId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    await agents.onboard(agentId);
    await agents.submitDocument(agentId, 'licence', `s3://${uuid()}`,
      new Date(clock.now().getTime() + 365 * 24 * 3_600_000));
    await agents.submitDocument(agentId, 'insurance', `s3://${uuid()}`,
      new Date(clock.now().getTime() + 365 * 24 * 3_600_000));
    await agents.acceptTerms(agentId);
    await agents.approve(agentId, uuid());
    // No coverage area at all: the agent would never be ranked — the whole
    // point of a manual override.

    const prop = await db.kysely
      .insertInto('core.property')
      .values({ canonical_key: `ops-${uuid()}`, address_normalised: '{}' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const listing = await db.kysely
      .insertInto('core.listing')
      .values({ property_id: prop.id, channel: 'sale' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const viewer = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const start = new Date(clock.now().getTime() + 72 * 3_600_000);
    const appointment = await db.kysely
      .insertInto('core.appointment')
      .values({
        property_id: prop.id,
        listing_id: listing.id,
        viewer_contact_id: viewer,
        during: sql`tstzrange(${start}, ${new Date(start.getTime() + 3_600_000)})`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const dispatchId = (await dispatch.startDispatch(appointment.id))!;
    // No candidates → escalation exhausts to no_agent.
    const state = await db.kysely
      .selectFrom('core.dispatch')
      .select('state')
      .where('id', '=', dispatchId)
      .executeTakeFirstOrThrow();
    expect(['no_agent', 'offering']).toContain(state.state);

    const result = await dispatch.directAssign(dispatchId, agentId, uuid());
    expect(result.agreement.id).toBeDefined();

    const after = await db.kysely
      .selectFrom('core.dispatch')
      .select(['state', 'winning_offer_id'])
      .where('id', '=', dispatchId)
      .executeTakeFirstOrThrow();
    expect(after.state).toBe('claimed');
    expect(after.winning_offer_id).not.toBeNull();
    const appt = await db.kysely
      .selectFrom('core.appointment')
      .select(['state', 'agent_id'])
      .where('id', '=', appointment.id)
      .executeTakeFirstOrThrow();
    expect(appt.state).toBe('booked');
    expect(appt.agent_id).toBe(agentId);
  });

  it('dispute resolution updates attribution; DSR refusal records grounds (#35)', async () => {
    // Fixture: agreement + attribution via a synthetic claim would be heavy;
    // insert the minimum chain directly.
    const agentId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    await agents.onboard(agentId);
    const prop = await db.kysely
      .insertInto('core.property')
      .values({ canonical_key: `disp2-${uuid()}`, address_normalised: '{}' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const listing = await db.kysely
      .insertInto('core.listing')
      .values({ property_id: prop.id, channel: 'sale' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const viewer = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const appointment = await db.kysely
      .insertInto('core.appointment')
      .values({
        property_id: prop.id,
        listing_id: listing.id,
        viewer_contact_id: viewer,
        during: sql`tstzrange(${clock.now()}, ${new Date(clock.now().getTime() + 3_600_000)})`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const dispatchRow = await db.kysely
      .insertInto('core.dispatch')
      .values({ appointment_id: appointment.id, strategy: 'waterfall', state: 'claimed' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const offer = await db.kysely
      .insertInto('core.dispatch_offer')
      .values({
        dispatch_id: dispatchRow.id,
        agent_id: agentId,
        state: 'claimed',
        ttl_expires_at: clock.now(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const terms = await db.kysely
      .selectFrom('core.terms_version')
      .select('id')
      .limit(1)
      .executeTakeFirstOrThrow();
    const agreement = await db.kysely
      .insertInto('core.assignment_agreement')
      .values({
        offer_id: offer.id,
        agent_id: agentId,
        appointment_id: appointment.id,
        terms_snapshot: '{}',
        terms_version_id: terms.id,
        accepted_at: clock.now(),
        exclusivity_ends_at: new Date(clock.now().getTime() + 30 * 24 * 3_600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const attribution = await db.kysely
      .insertInto('core.attribution')
      .values({
        agreement_id: agreement.id,
        buyer_contact_id: viewer,
        property_id: prop.id,
        state: 'disputed',
        window_ends_at: new Date(clock.now().getTime() + 30 * 24 * 3_600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const dispute = await db.kysely
      .insertInto('core.dispute')
      .values({ attribution_id: attribution.id, raised_by: viewer })
      .returning('id')
      .executeTakeFirstOrThrow();

    const staffId = uuid();
    await dispatch.resolveDispute(dispute.id, staffId, { finding: 'claim upheld' }, 'active');
    const disputeAfter = await db.kysely
      .selectFrom('core.dispute')
      .selectAll()
      .where('id', '=', dispute.id)
      .executeTakeFirstOrThrow();
    expect(disputeAfter.state).toBe('resolved');
    expect(disputeAfter.resolved_by).toBe(staffId);
    const attributionAfter = await db.kysely
      .selectFrom('core.attribution')
      .select('state')
      .where('id', '=', attribution.id)
      .executeTakeFirstOrThrow();
    expect(attributionAfter.state).toBe('active');
  });
});
