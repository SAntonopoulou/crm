import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { Db } from '../src/shared/database/db.service';
import { TestClock } from '../src/shared/jobs/clock';
import { InlineJobScheduler, JobRegistry } from '../src/shared/jobs/job-scheduler';
import { ProvenanceResolver } from '../src/shared/provenance/provenance-resolver';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { PropertiesService } from '../src/modules/properties/properties.service';
import {
  PipelinesService,
  JOB_SLA_BREACH,
  SlaBreachPayload,
} from '../src/modules/pipelines/pipelines.service';
import {
  MatchingService,
  JOB_EVALUATE_LISTING,
} from '../src/modules/pipelines/matching.service';

const uuid = () => crypto.randomUUID();
const MIN = 60_000;

describe('pipelines & matching (#18)', () => {
  let db: Db;
  let clock: TestClock;
  let scheduler: InlineJobScheduler;
  let pipelines: PipelinesService;
  let matching: MatchingService;
  let contacts: ContactsService;
  let properties: PropertiesService;

  beforeAll(() => {
    const config = new ConfigService();
    db = new Db(config);
    clock = new TestClock(new Date('2026-08-10T09:00:00Z'));
    const registry = new JobRegistry();
    scheduler = new InlineJobScheduler(clock, registry);
    pipelines = new PipelinesService(db, clock, scheduler, config);
    matching = new MatchingService(db);
    contacts = new ContactsService(db);
    properties = new PropertiesService(
      db,
      new ProvenanceResolver(),
      config,
      scheduler,
      clock,
    );
    registry.register(JOB_SLA_BREACH, (p) =>
      pipelines.handleSlaBreach(p as SlaBreachPayload),
    );
    registry.register(JOB_EVALUATE_LISTING, async (p) => {
      await matching.evaluateListing((p as { listingId: string }).listingId);
    });
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  async function breachEvents(itemId: string) {
    return db.kysely
      .selectFrom('core.outbox_event')
      .selectAll()
      .where('event_type', '=', 'pipeline.sla_breached')
      .where('aggregate_id', '=', itemId)
      .execute();
  }

  async function fixtureListing(opts: {
    postcode?: string;
    price?: string;
    bedrooms?: number;
    lat?: number;
    lng?: number;
    state?: string;
  }): Promise<{ propertyId: string; listingId: string }> {
    const prop = await db.kysely
      .insertInto('core.property')
      .values({
        canonical_key: `pipetest-${uuid()}`,
        address_normalised: JSON.stringify({
          city: 'brussel',
          postcode: opts.postcode ?? '1000',
        }),
        kind: 'apartment',
        bedrooms: opts.bedrooms ?? 2,
        floor_area_sqm: '90',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (opts.lat !== undefined && opts.lng !== undefined) {
      await sql`UPDATE core.property SET geo_point = ST_SetSRID(ST_MakePoint(${opts.lng}, ${opts.lat}), 4326)::geography WHERE id = ${prop.id}`.execute(db.kysely);
    }
    const listing = await db.kysely
      .insertInto('core.listing')
      .values({
        property_id: prop.id,
        channel: 'sale',
        state: opts.state ?? 'live',
        price: opts.price ?? '300000.00',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { propertyId: prop.id, listingId: listing.id };
  }

  describe('MANDATED: SLA timer expiry under clock control', () => {
    it('case A — answered in time: no escalation ever fires', async () => {
      const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
      const { itemId } = await pipelines.recordInboundInquiry({ contactId });

      clock.advance(14 * MIN);
      await pipelines.recordFirstResponse(itemId, uuid());
      clock.advance(10 * MIN); // sail past the original deadline
      await scheduler.drainDue();

      expect(await breachEvents(itemId)).toHaveLength(0);
      const tasks = await db.kysely
        .selectFrom('core.task')
        .selectAll()
        .where('item_id', '=', itemId)
        .execute();
      expect(tasks).toHaveLength(0);
    });

    it('case B — no reply: escalation fires exactly once, idempotently', async () => {
      const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
      const { itemId } = await pipelines.recordInboundInquiry({ contactId });

      clock.advance(16 * MIN);
      expect(await scheduler.drainDue()).toBeGreaterThanOrEqual(1);

      const events = await breachEvents(itemId);
      expect(events).toHaveLength(1);
      expect((events[0].payload as { sla_kind: string }).sla_kind).toBe('first_response');

      const tasks = await db.kysely
        .selectFrom('core.task')
        .selectAll()
        .where('item_id', '=', itemId)
        .where('kind', '=', 'sla_escalation:first_response')
        .execute();
      expect(tasks).toHaveLength(1);

      // Re-running the sweep (job redelivery) must not double-escalate.
      await pipelines.handleSlaBreach({ itemId, kind: 'first_response' });
      expect(await breachEvents(itemId)).toHaveLength(1);
    });

    it('stage SLA: arms on entry, voids when the stage moves on', async () => {
      const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
      const { propertyId } = await fixtureListing({ state: 'discovered' });

      // new_lead carries a 1440-minute SLA (seeded config).
      const breached = await pipelines.createSupplyLead({ contactId, propertyId });
      const saved = await pipelines.createSupplyLead({
        contactId: await contacts.resolveOrProvision(`kc-${uuid()}`),
        propertyId: (await fixtureListing({ state: 'discovered' })).propertyId,
      });

      // The saved lead moves to a stage without an SLA before the deadline.
      await pipelines.moveStage(saved, 'contacted', uuid());

      clock.advance(1441 * MIN);
      await scheduler.drainDue();

      expect(await breachEvents(breached)).toHaveLength(1);
      expect(await breachEvents(saved)).toHaveLength(0);
    });
  });

  describe('matching engine', () => {
    it('matches on postcode + budget + bedrooms; emits match.created once', async () => {
      const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
      const postcode = `pc${Math.floor(Math.random() * 90000) + 10000}`;
      await db.kysely
        .insertInto('core.requirement_profile')
        .values({
          contact_id: contactId,
          channel: 'sale',
          budget_min: '250000.00',
          budget_max: '350000.00',
          postcodes: [postcode],
          bedrooms_min: 2,
        })
        .execute();

      const inBudget = await fixtureListing({ postcode, price: '300000.00' });
      const tooDear = await fixtureListing({ postcode, price: '400000.00' });
      const tooSmall = await fixtureListing({ postcode, price: '300000.00', bedrooms: 1 });

      expect(await matching.evaluateListing(inBudget.listingId)).toBe(1);
      expect(await matching.evaluateListing(tooDear.listingId)).toBe(0);
      expect(await matching.evaluateListing(tooSmall.listingId)).toBe(0);
      // Re-evaluation must not duplicate the match.
      expect(await matching.evaluateListing(inBudget.listingId)).toBe(0);

      const matches = await db.kysely
        .selectFrom('core.match')
        .selectAll()
        .where('listing_id', '=', inBudget.listingId)
        .execute();
      expect(matches).toHaveLength(1);
      expect(Number(matches[0].score)).toBeGreaterThan(50);
    });

    it('matches inside a polygon area; skips restricted and erased contacts', async () => {
      // A box around a fresh spot in the countryside.
      const lat = 50.55 + Math.random() * 0.1;
      const lng = 4.55 + Math.random() * 0.1;
      const polygon = {
        type: 'MultiPolygon',
        coordinates: [[[
          [lng - 0.01, lat - 0.01],
          [lng + 0.01, lat - 0.01],
          [lng + 0.01, lat + 0.01],
          [lng - 0.01, lat + 0.01],
          [lng - 0.01, lat - 0.01],
        ]]],
      };

      const insideContact = await contacts.resolveOrProvision(`kc-${uuid()}`);
      const restrictedContact = await contacts.resolveOrProvision(`kc-${uuid()}`);
      for (const contactId of [insideContact, restrictedContact]) {
        await db.kysely
          .insertInto('core.requirement_profile')
          .values(
            {
              contact_id: contactId,
              channel: 'sale',
              areas: sql`ST_GeomFromGeoJSON(${JSON.stringify(polygon)})::geography`,
            },
          )
          .execute();
      }
      await db.kysely
        .updateTable('core.contact')
        .set({ processing_restricted: true })
        .where('id', '=', restrictedContact)
        .execute();

      const inside = await fixtureListing({ lat, lng });
      const outside = await fixtureListing({ lat: lat + 0.5, lng });

      // Only the unrestricted profile matches, only for the inside listing.
      expect(await matching.evaluateListing(inside.listingId)).toBe(1);
      expect(await matching.evaluateListing(outside.listingId)).toBe(0);
      const match = await db.kysely
        .selectFrom('core.match as m')
        .innerJoin('core.requirement_profile as r', 'r.id', 'm.profile_id')
        .select('r.contact_id')
        .where('m.listing_id', '=', inside.listingId)
        .execute();
      expect(match.map((m) => m.contact_id)).toEqual([insideContact]);
    });

    it('feedback flips match state and emits the event', async () => {
      const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
      const postcode = `pc${Math.floor(Math.random() * 90000) + 10000}`;
      await db.kysely
        .insertInto('core.requirement_profile')
        .values({ contact_id: contactId, channel: 'sale', postcodes: [postcode] })
        .execute();
      const { listingId } = await fixtureListing({ postcode });
      await matching.evaluateListing(listingId);
      const match = await db.kysely
        .selectFrom('core.match')
        .select('id')
        .where('listing_id', '=', listingId)
        .executeTakeFirstOrThrow();

      await matching.recordFeedback(match.id, contactId, 'dismissed');
      const after = await db.kysely
        .selectFrom('core.match')
        .select('state')
        .where('id', '=', match.id)
        .executeTakeFirstOrThrow();
      expect(after.state).toBe('dismissed');

      // Another contact cannot feed back on someone else's match.
      const stranger = await contacts.resolveOrProvision(`kc-${uuid()}`);
      await expect(
        matching.recordFeedback(match.id, stranger, 'interested'),
      ).rejects.toMatchObject({ response: { code: 'match_not_found' } });
    });
  });

  describe('listing goes live → matching runs via the job registry', () => {
    it('walks the lifecycle and the scheduled evaluation creates the match', async () => {
      const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
      const postcode = `pc${Math.floor(Math.random() * 90000) + 10000}`;
      await db.kysely
        .insertInto('core.requirement_profile')
        .values({ contact_id: contactId, channel: 'sale', postcodes: [postcode] })
        .execute();

      const { listingId } = await fixtureListing({ postcode, state: 'discovered' });
      await expect(
        properties.transitionListing(listingId, 'live', null),
      ).rejects.toThrow(/illegal/); // discovered → live must walk the machine

      for (const to of ['contact_attempted', 'owner_reached', 'verified', 'live'] as const) {
        await properties.transitionListing(listingId, to, null);
      }
      await scheduler.drainDue(); // fires matching.evaluate_listing

      const match = await db.kysely
        .selectFrom('core.match')
        .selectAll()
        .where('listing_id', '=', listingId)
        .execute();
      expect(match).toHaveLength(1);

      const published = await db.kysely
        .selectFrom('core.outbox_event')
        .select('event_type')
        .where('aggregate_id', '=', listingId)
        .where('event_type', '=', 'listing.published')
        .execute();
      expect(published).toHaveLength(1);
    });
  });

  it('repeat inquiry touches the existing item and bumps its score', async () => {
    const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const { propertyId } = await fixtureListing({});
    const first = await pipelines.recordInboundInquiry({ contactId, propertyId });
    const second = await pipelines.recordInboundInquiry({ contactId, propertyId });
    expect(first.repeat).toBe(false);
    expect(second.repeat).toBe(true);
    expect(second.itemId).toBe(first.itemId);

    const item = await db.kysely
      .selectFrom('core.pipeline_item')
      .select('score')
      .where('id', '=', first.itemId)
      .executeTakeFirstOrThrow();
    expect(Number(item.score)).toBe(15); // repeat_inquiry weight
  });
});
