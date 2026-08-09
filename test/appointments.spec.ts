import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { Db } from '../src/shared/database/db.service';
import { TestClock } from '../src/shared/jobs/clock';
import { InlineJobScheduler, JobRegistry } from '../src/shared/jobs/job-scheduler';
import { wallClockToUtc } from '../src/shared/time';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { PipelinesService } from '../src/modules/pipelines/pipelines.service';
import {
  AppointmentsService,
  JOB_HOLD_EXPIRE,
} from '../src/modules/appointments/appointments.service';

const uuid = () => crypto.randomUUID();
const HOUR = 3_600_000;

describe('appointments (#19)', () => {
  let db: Db;
  let clock: TestClock;
  let scheduler: InlineJobScheduler;
  let appointments: AppointmentsService;
  let contacts: ContactsService;

  beforeAll(() => {
    const config = new ConfigService();
    db = new Db(config);
    clock = new TestClock(new Date('2027-03-20T08:00:00Z'));
    const registry = new JobRegistry();
    scheduler = new InlineJobScheduler(clock, registry);
    const pipelines = new PipelinesService(db, clock, scheduler, config);
    appointments = new AppointmentsService(db, clock, pipelines, scheduler, config);
    registry.register(JOB_HOLD_EXPIRE, (p) =>
      appointments.expireHold((p as { holdId: string }).holdId),
    );
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  async function fixtureListing(opts?: {
    occupancy?: 'vacant' | 'owner_occupied' | 'tenanted';
    minNoticeHours?: number;
    geo?: { lat: number; lng: number };
  }): Promise<{ propertyId: string; listingId: string }> {
    const prop = await db.kysely
      .insertInto('core.property')
      .values({
        canonical_key: `appt-${uuid()}`,
        address_normalised: JSON.stringify({ city: 'brussel', postcode: '1000' }),
        kind: 'apartment',
        timezone: 'Europe/Brussels',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (opts?.geo) {
      await sql`UPDATE core.property SET geo_point = ST_SetSRID(ST_MakePoint(${opts.geo.lng}, ${opts.geo.lat}), 4326)::geography WHERE id = ${prop.id}`.execute(db.kysely);
    }
    if (opts?.occupancy || opts?.minNoticeHours !== undefined) {
      await db.kysely
        .insertInto('core.property_access_rule')
        .values({
          property_id: prop.id,
          occupancy: opts?.occupancy ?? null,
          min_notice_hours: opts?.minNoticeHours ?? null,
        })
        .execute();
    }
    const listing = await db.kysely
      .insertInto('core.listing')
      .values({ property_id: prop.id, channel: 'sale', state: 'live', price: '300000.00' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { propertyId: prop.id, listingId: listing.id };
  }

  function brussels(y: number, m: number, d: number, hh: number): Date {
    return wallClockToUtc('Europe/Brussels', { year: y, month: m, day: d }, hh, 0);
  }

  describe('MANDATED: availability conflicts are rejected by the database', () => {
    it('overlapping appointments violate the exclusion constraint even via raw SQL', async () => {
      const { propertyId, listingId } = await fixtureListing();
      const viewer = await contactFixture();
      const start = brussels(2027, 4, 6, 10);
      const end = brussels(2027, 4, 6, 11);

      const insert = (s: Date, e: Date) =>
        db.kysely
          .insertInto('core.appointment')
          .values({
            property_id: propertyId,
            listing_id: listingId,
            viewer_contact_id: viewer,
            during: sql`tstzrange(${s}, ${e})`,
          })
          .execute();

      await insert(start, end);
      // 30-minute overlap — the DATABASE rejects it, not application logic.
      await expect(
        insert(new Date(start.getTime() + 30 * 60_000), new Date(end.getTime() + 30 * 60_000)),
      ).rejects.toThrow(/appointment_no_property_overlap/);
      // Adjacent (touching) ranges are fine: [10,11) ∪ [11,12).
      await insert(end, new Date(end.getTime() + HOUR));
    });

    it('a live hold blocks a second hold on the same range → 409 slot_conflict', async () => {
      const { listingId } = await fixtureListing({ minNoticeHours: 1 });
      const [a, b] = [await contactFixture(), await contactFixture()];
      const start = new Date(clock.now().getTime() + 3 * HOUR);
      const end = new Date(start.getTime() + HOUR);

      await appointments.placeHold(a, listingId, start, end);
      await expect(
        appointments.placeHold(b, listingId, start, end),
      ).rejects.toMatchObject({ response: { code: 'slot_conflict' } });
    });
  });

  describe('MANDATED: minimum notice in the property timezone, incl. DST edges', () => {
    it('tenanted 48h rule: 47h fails, 49h succeeds', async () => {
      const { listingId } = await fixtureListing({ occupancy: 'tenanted' });
      const viewer = await contactFixture();
      const now = clock.now();

      await expect(
        appointments.placeHold(
          viewer,
          listingId,
          new Date(now.getTime() + 47 * HOUR),
          new Date(now.getTime() + 48 * HOUR),
        ),
      ).rejects.toMatchObject({ response: { code: 'min_notice', min_notice_hours: 48 } });

      const ok = await appointments.placeHold(
        viewer,
        listingId,
        new Date(now.getTime() + 49 * HOUR),
        new Date(now.getTime() + 50 * HOUR),
      );
      expect(ok.expires_at).toBeDefined();
    });

    it('slot generation is wall-clock-correct across the spring-forward (2027-03-28)', async () => {
      const { listingId } = await fixtureListing({ minNoticeHours: 2 });
      // Clock is 2027-03-20; Brussels switches CET→CEST on 2027-03-28.
      const winterDay = await appointments.viewingSlots(
        listingId,
        brussels(2027, 3, 26, 0),
        brussels(2027, 3, 27, 0),
      );
      const summerDay = await appointments.viewingSlots(
        listingId,
        brussels(2027, 3, 29, 0),
        brussels(2027, 3, 30, 0),
      );

      // First slot of the day is 09:00 local in both worlds…
      const firstWinter = new Date(winterDay.items[0].starts_at);
      const firstSummer = new Date(summerDay.items[0].starts_at);
      // …which is 08:00Z in winter (UTC+1) but 07:00Z in summer (UTC+2).
      expect(firstWinter.toISOString()).toBe('2027-03-26T08:00:00.000Z');
      expect(firstSummer.toISOString()).toBe('2027-03-29T07:00:00.000Z');
      // Both days offer the same 10 wall-clock slots (09:00–19:00, 60 min).
      expect(winterDay.items).toHaveLength(10);
      expect(summerDay.items).toHaveLength(10);
    });

    it('booked ranges and blackouts disappear from generated slots', async () => {
      const { propertyId, listingId } = await fixtureListing({ minNoticeHours: 1 });
      const viewer = await contactFixture();
      const day = { from: brussels(2027, 4, 7, 0), to: brussels(2027, 4, 8, 0) };

      await db.kysely
        .insertInto('core.appointment')
        .values({
          property_id: propertyId,
          listing_id: listingId,
          viewer_contact_id: viewer,
          during: sql`tstzrange(${brussels(2027, 4, 7, 10)}, ${brussels(2027, 4, 7, 11)})`,
        })
        .execute();

      const slots = await appointments.viewingSlots(listingId, day.from, day.to);
      const starts = slots.items.map((s) => s.starts_at);
      expect(starts).not.toContain(brussels(2027, 4, 7, 10).toISOString());
      expect(starts).toContain(brussels(2027, 4, 7, 11).toISOString());
      expect(slots.items).toHaveLength(9); // 10 minus the booked hour
    });
  });

  describe('MANDATED: hold TTL auto-release', () => {
    it('expires under the clock, frees the range, and a stale hold cannot book', async () => {
      const { listingId } = await fixtureListing({ minNoticeHours: 1 });
      const [a, b] = [await contactFixture(), await contactFixture()];
      const start = new Date(clock.now().getTime() + 30 * HOUR);
      const end = new Date(start.getTime() + HOUR);

      const hold = await appointments.placeHold(a, listingId, start, end);

      clock.advance(5 * 60_000);
      await scheduler.drainDue();
      let state = await holdState(hold.id);
      expect(state).toBe('held'); // TTL is 10 minutes; not yet

      clock.advance(6 * 60_000);
      await scheduler.drainDue();
      state = await holdState(hold.id);
      expect(state).toBe('expired');

      // The range is free again for someone else…
      const second = await appointments.placeHold(b, listingId, start, end);
      expect(second.id).not.toBe(hold.id);
      // …and the expired hold can no longer be converted.
      await expect(appointments.book(a, hold.id)).rejects.toMatchObject({
        response: { code: 'hold_expired' },
      });
    });
  });

  describe('booking, attendance, outcome', () => {
    it('hold → book → walk to completed via geofence proofs → outcome routes to demand pipeline', async () => {
      const geo = { lat: 50.84, lng: 4.35 };
      const { propertyId, listingId } = await fixtureListing({ minNoticeHours: 1, geo });
      const viewer = await contactFixture();
      const agent = await contactFixture();
      const start = new Date(clock.now().getTime() + 24 * HOUR);

      const hold = await appointments.placeHold(
        viewer, listingId, start, new Date(start.getTime() + HOUR),
      );
      const booked = (await appointments.book(viewer, hold.id, 'ring twice')) as { id: string; state: string };
      expect(booked.state).toBe('dispatching');

      // Hold is consumed — booking it again fails cleanly.
      await expect(appointments.book(viewer, hold.id)).rejects.toMatchObject({
        response: { code: 'hold_expired' },
      });

      // Simulate the dispatch claim (module #21 does this for real).
      await db.kysely
        .updateTable('core.appointment')
        .set({ agent_id: agent, state: 'booked' })
        .where('id', '=', booked.id)
        .execute();
      await appointments.transition(booked.id, 'confirmed');

      // Geofence: 5+ km away is rejected, on-site passes.
      await expect(
        appointments.recordAttendance(booked.id, 'agent', 'check_in', {
          method: 'geofence',
          location: { lat: 50.89, lng: 4.35 },
        }),
      ).rejects.toMatchObject({ response: { code: 'geofence_out_of_range' } });
      await appointments.recordAttendance(booked.id, 'agent', 'check_in', {
        method: 'geofence',
        location: { lat: 50.8401, lng: 4.3502 },
      });
      expect(await apptState(booked.id)).toBe('in_progress');

      await appointments.recordAttendance(booked.id, 'agent', 'check_out', {
        method: 'geofence',
        location: { lat: 50.8401, lng: 4.3502 },
      });
      expect(await apptState(booked.id)).toBe('completed');

      await appointments.recordOutcome(booked.id, 'interested', 'wants a second visit');
      expect(await apptState(booked.id)).toBe('outcome_captured');

      const outcome = await db.kysely
        .selectFrom('core.viewing_outcome')
        .selectAll()
        .where('appointment_id', '=', booked.id)
        .executeTakeFirstOrThrow();
      expect(outcome.routed_pipeline_item_id).not.toBeNull();
      const item = await db.kysely
        .selectFrom('core.pipeline_item')
        .select(['contact_id', 'property_id'])
        .where('id', '=', outcome.routed_pipeline_item_id!)
        .executeTakeFirstOrThrow();
      expect(item.contact_id).toBe(viewer);
      expect(item.property_id).toBe(propertyId);
    });

    it('late cancellation applies the penalty flag; illegal transitions are typed errors', async () => {
      const { listingId } = await fixtureListing({ minNoticeHours: 1 });
      const viewer = await contactFixture();
      const start = new Date(clock.now().getTime() + 4 * HOUR); // inside 24h notice

      const hold = await appointments.placeHold(
        viewer, listingId, start, new Date(start.getTime() + HOUR),
      );
      const booked = (await appointments.book(viewer, hold.id)) as { id: string };

      await appointments.transition(booked.id, 'cancelled', { byParty: 'viewer' });
      const row = await db.kysely
        .selectFrom('core.appointment')
        .select(['penalty_applied', 'cancelled_by'])
        .where('id', '=', booked.id)
        .executeTakeFirstOrThrow();
      expect(row.penalty_applied).toBe(true); // < 24h before start
      expect(row.cancelled_by).toBe('viewer');

      await expect(
        appointments.transition(booked.id, 'confirmed'),
      ).rejects.toThrow(/illegal appointment transition/);
    });
  });

  async function contactFixture(): Promise<string> {
    contacts ??= new ContactsService(db);
    return contacts.resolveOrProvision(`kc-${uuid()}`);
  }

  async function holdState(id: string): Promise<string> {
    const row = await db.kysely
      .selectFrom('core.slot_hold')
      .select('state')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return row.state;
  }

  async function apptState(id: string): Promise<string> {
    const row = await db.kysely
      .selectFrom('core.appointment')
      .select('state')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return row.state;
  }
});
