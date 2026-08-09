import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { Db, TxContext } from '../../shared/database/db.service';
import { Clock } from '../../shared/jobs/clock';
import { JobScheduler } from '../../shared/jobs/job-scheduler';
import { addDays, localDateOf, wallClockToUtc } from '../../shared/time';
import { PipelinesService } from '../pipelines/pipelines.service';
import { appointmentMachine, AppointmentState } from './appointment-machine';

export const JOB_HOLD_EXPIRE = 'appointment.hold_expire';

const HOLD_TTL_MINUTES_DEFAULT = 10;
const CANCEL_NOTICE_HOURS_DEFAULT = 24;
const GEOFENCE_METERS = 250;
const SLOT_WINDOW_DAYS_MAX = 14;

/** Notice defaults per occupancy when no explicit rule row exists. */
const DEFAULT_MIN_NOTICE_HOURS: Record<string, number> = {
  tenanted: 48,
  owner_occupied: 24,
  vacant: 2,
};

interface AccessRule {
  occupancy: string | null;
  min_notice_hours: number | null;
  viewing_hours: { start: string; end: string };
  slot_minutes: number;
  blackout_windows: { start: string; end: string }[];
}

const DEFAULT_RULE: AccessRule = {
  occupancy: null,
  min_notice_hours: null,
  viewing_hours: { start: '09:00', end: '19:00' },
  slot_minutes: 60,
  blackout_windows: [],
};

@Injectable()
export class AppointmentsService {
  private readonly holdTtlMinutes: number;
  private readonly cancelNoticeHours: number;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly pipelines: PipelinesService,
    @Optional() private readonly jobs?: JobScheduler,
    @Optional() config?: ConfigService,
  ) {
    this.holdTtlMinutes = Number(config?.get('HOLD_TTL_MINUTES') ?? HOLD_TTL_MINUTES_DEFAULT);
    this.cancelNoticeHours = Number(
      config?.get('CANCEL_NOTICE_HOURS') ?? CANCEL_NOTICE_HOURS_DEFAULT,
    );
  }

  private minNoticeHours(rule: AccessRule): number {
    if (rule.min_notice_hours !== null) return rule.min_notice_hours;
    return DEFAULT_MIN_NOTICE_HOURS[rule.occupancy ?? 'owner_occupied'] ?? 24;
  }

  private async accessRule(propertyId: string): Promise<AccessRule> {
    const row = await this.db.kysely
      .selectFrom('core.property_access_rule')
      .selectAll()
      .where('property_id', '=', propertyId)
      .executeTakeFirst();
    if (!row) {
      // Occupancy may still be known on the property itself (from ingest).
      const property = await this.db.kysely
        .selectFrom('core.property')
        .select('occupancy')
        .where('id', '=', propertyId)
        .executeTakeFirst();
      return { ...DEFAULT_RULE, occupancy: property?.occupancy ?? null };
    }
    return {
      occupancy: row.occupancy,
      min_notice_hours: row.min_notice_hours,
      viewing_hours: row.viewing_hours as AccessRule['viewing_hours'],
      slot_minutes: row.slot_minutes,
      blackout_windows: row.blackout_windows as AccessRule['blackout_windows'],
    };
  }

  /**
   * Contract: GET /listings/{id}/viewing-slots. Generated in the property's
   * timezone from access rules; existing appointments and live holds are
   * subtracted. Slots are availability, not reservations.
   */
  async viewingSlots(
    listingId: string,
    from?: Date,
    to?: Date,
  ): Promise<{ items: { starts_at: string; ends_at: string; kind: string }[] }> {
    const listing = await this.db.kysely
      .selectFrom('core.listing as l')
      .innerJoin('core.property as p', 'p.id', 'l.property_id')
      .select(['l.id', 'p.id as property_id', 'p.timezone'])
      .where('l.id', '=', listingId)
      .executeTakeFirst();
    if (!listing) throw new NotFoundException({ code: 'listing_not_found' });

    const rule = await this.accessRule(listing.property_id);
    const now = this.clock.now();
    const earliest = new Date(
      now.getTime() + this.minNoticeHours(rule) * 3_600_000,
    );
    const windowStart = from && from > earliest ? from : earliest;
    const capMs = SLOT_WINDOW_DAYS_MAX * 24 * 3_600_000;
    const windowEnd =
      to && to.getTime() - windowStart.getTime() < capMs
        ? to
        : new Date(windowStart.getTime() + capMs);

    const busy = await this.busyRanges(listing.property_id, windowStart, windowEnd);
    const blackouts = rule.blackout_windows.map((b) => ({
      start: new Date(b.start),
      end: new Date(b.end),
    }));

    const [startH, startM] = rule.viewing_hours.start.split(':').map(Number);
    const [endH, endM] = rule.viewing_hours.end.split(':').map(Number);
    const items: { starts_at: string; ends_at: string; kind: string }[] = [];

    const serial = (d: { year: number; month: number; day: number }) =>
      d.year * 10000 + d.month * 100 + d.day;
    let day = localDateOf(listing.timezone, windowStart);
    const lastDay = localDateOf(listing.timezone, windowEnd);
    for (
      let i = 0;
      i < SLOT_WINDOW_DAYS_MAX + 2 && serial(day) <= serial(lastDay);
      i++, day = addDays(day, 1)
    ) {
      const dayStart = wallClockToUtc(listing.timezone, day, startH, startM);
      const dayEnd = wallClockToUtc(listing.timezone, day, endH, endM);
      for (
        let t = dayStart.getTime();
        t + rule.slot_minutes * 60_000 <= dayEnd.getTime();
        t += rule.slot_minutes * 60_000
      ) {
        const slotStart = new Date(t);
        const slotEnd = new Date(t + rule.slot_minutes * 60_000);
        if (slotStart < windowStart || slotEnd > windowEnd) continue;
        const overlaps = (r: { start: Date; end: Date }) =>
          slotStart < r.end && slotEnd > r.start;
        if (blackouts.some(overlaps) || busy.some(overlaps)) continue;
        items.push({
          starts_at: slotStart.toISOString(),
          ends_at: slotEnd.toISOString(),
          kind: 'private',
        });
      }
    }
    return { items };
  }

  private async busyRanges(
    propertyId: string,
    from: Date,
    to: Date,
  ): Promise<{ start: Date; end: Date }[]> {
    const rows = await sql<{ s: Date; e: Date }>`
      SELECT lower(during) AS s, upper(during) AS e FROM core.appointment
       WHERE property_id = ${propertyId}
         AND state IN ('dispatching','unstaffed','booked','confirmed','in_progress')
         AND during && tstzrange(${from}, ${to})
      UNION ALL
      SELECT lower(during), upper(during) FROM core.slot_hold
       WHERE property_id = ${propertyId} AND state = 'held'
         AND during && tstzrange(${from}, ${to})
    `.execute(this.db.kysely);
    return rows.rows.map((r) => ({ start: r.s, end: r.e }));
  }

  /** Contract: POST /appointments/holds — TTL reservation while the viewer decides. */
  async placeHold(
    viewerContactId: string,
    listingId: string,
    startsAt: Date,
    endsAt: Date,
  ): Promise<{ id: string; listing_id: string; starts_at: string; ends_at: string; expires_at: string }> {
    if (endsAt <= startsAt) {
      throw new UnprocessableEntityException({ code: 'invalid_range' });
    }
    const listing = await this.db.kysely
      .selectFrom('core.listing')
      .select(['id', 'property_id'])
      .where('id', '=', listingId)
      .executeTakeFirst();
    if (!listing) throw new NotFoundException({ code: 'listing_not_found' });

    const rule = await this.accessRule(listing.property_id);
    const now = this.clock.now();
    if (startsAt.getTime() - now.getTime() < this.minNoticeHours(rule) * 3_600_000) {
      throw new ConflictException({
        code: 'min_notice',
        min_notice_hours: this.minNoticeHours(rule),
      });
    }

    const expiresAt = new Date(now.getTime() + this.holdTtlMinutes * 60_000);
    try {
      const hold = await this.db.tx(async (ctx) => {
        const row = await ctx.trx
          .insertInto('core.slot_hold')
          .values({
            property_id: listing.property_id,
            listing_id: listingId,
            viewer_contact_id: viewerContactId,
            during: sql`tstzrange(${startsAt}, ${endsAt})`,
            expires_at: expiresAt,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await ctx.emit({
          aggregateType: 'appointment',
          aggregateId: row.id,
          eventType: 'appointment.hold_placed',
          payload: { listing_id: listingId, expires_at: expiresAt.toISOString() },
        });
        return row;
      });
      await this.jobs?.schedule(
        JOB_HOLD_EXPIRE,
        { holdId: hold.id },
        expiresAt,
        { dedupeId: `hold:${hold.id}` },
      );
      return {
        id: hold.id,
        listing_id: listingId,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      };
    } catch (err) {
      if (this.isExclusionViolation(err)) {
        throw new ConflictException({ code: 'slot_conflict' });
      }
      throw err;
    }
  }

  /** Job handler: auto-release expired holds. */
  async expireHold(holdId: string): Promise<void> {
    const now = this.clock.now();
    await this.db.tx(async (ctx) => {
      const hold = await ctx.trx
        .selectFrom('core.slot_hold')
        .select(['id', 'state', 'expires_at'])
        .where('id', '=', holdId)
        .forUpdate()
        .executeTakeFirst();
      if (!hold || hold.state !== 'held' || hold.expires_at.getTime() > now.getTime()) {
        return;
      }
      await ctx.trx
        .updateTable('core.slot_hold')
        .set({ state: 'expired' })
        .where('id', '=', holdId)
        .execute();
      await ctx.emit({
        aggregateType: 'appointment',
        aggregateId: holdId,
        eventType: 'appointment.hold_expired',
        payload: {},
      });
    });
  }

  /** Contract: POST /appointments — convert a live hold into a booking. */
  async book(
    viewerContactId: string,
    holdId: string,
    notes?: string,
  ): Promise<Record<string, unknown>> {
    const now = this.clock.now();
    const appointmentId = await this.db.tx(async (ctx) => {
      const hold = await ctx.trx
        .selectFrom('core.slot_hold')
        .select(['id', 'property_id', 'listing_id', 'viewer_contact_id', 'state', 'expires_at',
          sql<Date>`lower(during)`.as('starts_at'),
          sql<Date>`upper(during)`.as('ends_at'),
        ])
        .where('id', '=', holdId)
        .forUpdate()
        .executeTakeFirst();
      if (!hold) throw new NotFoundException({ code: 'hold_not_found' });
      if (hold.viewer_contact_id !== viewerContactId) {
        throw new ForbiddenException({ code: 'not_your_hold' });
      }
      if (hold.state !== 'held' || hold.expires_at.getTime() <= now.getTime()) {
        throw new GoneException({ code: 'hold_expired' });
      }

      // Re-validate notice: the rule may have changed since the hold.
      const rule = await this.accessRule(hold.property_id);
      if (hold.starts_at.getTime() - now.getTime() < this.minNoticeHours(rule) * 3_600_000) {
        throw new ConflictException({ code: 'min_notice' });
      }

      await ctx.trx
        .updateTable('core.slot_hold')
        .set({ state: 'converted' })
        .where('id', '=', holdId)
        .execute();
      const appointment = await ctx.trx
        .insertInto('core.appointment')
        .values({
          property_id: hold.property_id,
          listing_id: hold.listing_id,
          viewer_contact_id: viewerContactId,
          during: sql`tstzrange(${hold.starts_at}, ${hold.ends_at})`,
          notes: notes ?? null,
          one_time_code: String(Math.floor(100000 + Math.random() * 900000)),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await ctx.emit({
        aggregateType: 'appointment',
        aggregateId: appointment.id,
        eventType: 'appointment.state_changed',
        payload: { from: null, to: 'dispatching' },
      });
      await ctx.emit({
        aggregateType: 'appointment',
        aggregateId: appointment.id,
        eventType: 'appointment.awaiting_agent',
        payload: { property_id: hold.property_id },
      });
      await this.pipelines.logActivity(ctx, {
        contactId: viewerContactId,
        propertyId: hold.property_id,
        kind: 'viewing_booked',
      });
      return appointment.id;
    });
    await this.jobs?.cancel(`hold:${holdId}`);
    // Kick off agent dispatch (handler registered by the dispatch module).
    await this.jobs?.schedule('dispatch.start', { appointmentId }, this.clock.now());
    return this.getAppointment(appointmentId);
  }

  async getAppointment(appointmentId: string): Promise<Record<string, unknown>> {
    const row = await this.db.kysely
      .selectFrom('core.appointment as a')
      .innerJoin('core.property as p', 'p.id', 'a.property_id')
      .select([
        'a.id', 'a.listing_id', 'a.state', 'a.kind', 'a.viewer_contact_id',
        'a.agent_id', 'a.penalty_applied', 'a.cancelled_by',
        sql<Date>`lower(a.during)`.as('starts_at'),
        sql<Date>`upper(a.during)`.as('ends_at'),
        sql<string | null>`p.address_normalised->>'city'`.as('city'),
      ])
      .where('a.id', '=', appointmentId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException({ code: 'appointment_not_found' });
    return {
      id: row.id,
      listing_id: row.listing_id,
      state: row.state,
      kind: row.kind,
      starts_at: row.starts_at.toISOString(),
      ends_at: row.ends_at.toISOString(),
      property_summary: { city: row.city },
      viewer: { contact_id: row.viewer_contact_id },
      ...(row.agent_id ? { agent: { contact_id: row.agent_id } } : {}),
      cancellation_policy: {
        free_until: new Date(
          row.starts_at.getTime() - this.cancelNoticeHours * 3_600_000,
        ).toISOString(),
      },
    };
  }

  async listForContact(contactId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.db.kysely
      .selectFrom('core.appointment')
      .select('id')
      .where((eb) =>
        eb.or([eb('viewer_contact_id', '=', contactId), eb('agent_id', '=', contactId)]),
      )
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
    const out: Record<string, unknown>[] = [];
    for (const r of rows) out.push(await this.getAppointment(r.id));
    return out;
  }

  /**
   * Open-house registration: positions within capacity are confirmed
   * attendees, the rest are waitlisted. Capacity null = unlimited.
   */
  async registerForOpenHouse(
    appointmentId: string,
    contactId: string,
  ): Promise<{ position: number; confirmed: boolean }> {
    return this.db.tx(async (ctx) => {
      const appointment = await ctx.trx
        .selectFrom('core.appointment')
        .select(['id', 'kind', 'state', 'capacity'])
        .where('id', '=', appointmentId)
        .forUpdate()
        .executeTakeFirst();
      if (!appointment) throw new NotFoundException({ code: 'appointment_not_found' });
      if (appointment.kind !== 'open_house') {
        throw new ConflictException({ code: 'not_open_house' });
      }
      if (!['dispatching', 'unstaffed', 'booked', 'confirmed'].includes(appointment.state)) {
        throw new ConflictException({ code: 'state_conflict' });
      }

      const existing = await ctx.trx
        .selectFrom('core.waitlist_entry')
        .select('position')
        .where('appointment_id', '=', appointmentId)
        .where('contact_id', '=', contactId)
        .executeTakeFirst();
      let position: number;
      if (existing) {
        position = existing.position;
      } else {
        const max = await ctx.trx
          .selectFrom('core.waitlist_entry')
          .select(sql<string>`COALESCE(max(position), 0)`.as('max'))
          .where('appointment_id', '=', appointmentId)
          .executeTakeFirstOrThrow();
        position = Number(max.max) + 1;
        await ctx.trx
          .insertInto('core.waitlist_entry')
          .values({ appointment_id: appointmentId, contact_id: contactId, position })
          .execute();
      }
      const confirmed =
        appointment.capacity === null || position <= appointment.capacity;
      await ctx.emit({
        aggregateType: 'appointment',
        aggregateId: appointmentId,
        eventType: 'appointment.open_house_registered',
        payload: { position, confirmed },
      });
      return { position, confirmed };
    });
  }

  /** Unregister; the first waitlisted viewer (if any) is promoted and notified. */
  async unregisterFromOpenHouse(
    appointmentId: string,
    contactId: string,
  ): Promise<void> {
    const promoted = await this.db.tx(async (ctx) => {
      const appointment = await ctx.trx
        .selectFrom('core.appointment')
        .select(['id', 'capacity'])
        .where('id', '=', appointmentId)
        .forUpdate()
        .executeTakeFirst();
      if (!appointment) throw new NotFoundException({ code: 'appointment_not_found' });

      const confirmedBefore = await this.confirmedSet(ctx, appointmentId, appointment.capacity);
      const deleted = await ctx.trx
        .deleteFrom('core.waitlist_entry')
        .where('appointment_id', '=', appointmentId)
        .where('contact_id', '=', contactId)
        .returning('id')
        .executeTakeFirst();
      if (!deleted) throw new NotFoundException({ code: 'not_registered' });

      const confirmedAfter = await this.confirmedSet(ctx, appointmentId, appointment.capacity);
      return [...confirmedAfter].filter(
        (id) => !confirmedBefore.has(id) && id !== contactId,
      );
    });
    for (const contact of promoted) {
      await this.jobs?.schedule(
        'notification.send',
        {
          contactId: contact,
          category: 'transactional',
          priority: 'high',
          kind: 'open_house_promoted',
          payload: { appointment_id: appointmentId },
        },
        this.clock.now(),
      );
    }
  }

  private async confirmedSet(
    ctx: TxContext,
    appointmentId: string,
    capacity: number | null,
  ): Promise<Set<string>> {
    const rows = await ctx.trx
      .selectFrom('core.waitlist_entry')
      .select(['contact_id'])
      .where('appointment_id', '=', appointmentId)
      .orderBy('position')
      .execute();
    const cut = capacity === null ? rows.length : capacity;
    return new Set(rows.slice(0, cut).map((r) => r.contact_id));
  }

  /** Agent-initiated withdrawal runs in the dispatch module via the job seam. */
  async scheduleAgentWithdrawal(appointmentId: string): Promise<void> {
    await this.jobs?.schedule(
      'dispatch.agent_withdraw',
      { appointmentId, reason: 'cancelled' },
      this.clock.now(),
      { dedupeId: `withdraw:${appointmentId}` },
    );
  }

  /** Central guarded transition with side effects. */
  async transition(
    appointmentId: string,
    to: AppointmentState,
    opts: {
      byParty?: 'viewer' | 'agent' | 'staff';
      reason?: string;
      actorId?: string;
    } = {},
  ): Promise<void> {
    const now = this.clock.now();
    await this.db.tx(async (ctx) => {
      const appointment = await ctx.trx
        .selectFrom('core.appointment')
        .select(['id', 'state', 'viewer_contact_id', 'agent_id', 'property_id',
          sql<Date>`lower(during)`.as('starts_at')])
        .where('id', '=', appointmentId)
        .forUpdate()
        .executeTakeFirst();
      if (!appointment) throw new NotFoundException({ code: 'appointment_not_found' });

      const from = appointment.state as AppointmentState;
      appointmentMachine.assert(from, to);

      const updates: Record<string, unknown> = { state: to };
      if (to === 'cancelled') {
        updates.cancelled_by = opts.byParty ?? 'staff';
        updates.cancel_reason = opts.reason ?? null;
        updates.penalty_applied =
          now.getTime() >
          appointment.starts_at.getTime() - this.cancelNoticeHours * 3_600_000;
      }
      if (to === 'no_show') {
        updates.cancelled_by = opts.byParty ?? null; // records which side failed
      }
      await ctx.trx
        .updateTable('core.appointment')
        .set(updates)
        .where('id', '=', appointmentId)
        .execute();
      await ctx.emit({
        aggregateType: 'appointment',
        aggregateId: appointmentId,
        eventType: 'appointment.state_changed',
        payload: { from, to, by_party: opts.byParty ?? null },
      });
    });
  }

  /** Attendance proof; agent check-in starts the visit, check-out ends it. */
  async recordAttendance(
    appointmentId: string,
    party: 'agent' | 'viewer',
    direction: 'check_in' | 'check_out',
    proof: { method: 'geofence' | 'one_time_code'; location?: { lat: number; lng: number }; code?: string },
  ): Promise<void> {
    const appointment = await this.db.kysely
      .selectFrom('core.appointment as a')
      .innerJoin('core.property as p', 'p.id', 'a.property_id')
      .select(['a.id', 'a.state', 'a.one_time_code',
        sql<string | null>`ST_Y(p.geo_point::geometry)::text`.as('lat'),
        sql<string | null>`ST_X(p.geo_point::geometry)::text`.as('lng'),
      ])
      .where('a.id', '=', appointmentId)
      .executeTakeFirst();
    if (!appointment) throw new NotFoundException({ code: 'appointment_not_found' });

    if (proof.method === 'geofence') {
      if (!proof.location || appointment.lat === null || appointment.lng === null) {
        throw new UnprocessableEntityException({ code: 'geofence_unavailable' });
      }
      const meters = haversineMeters(
        proof.location.lat,
        proof.location.lng,
        Number(appointment.lat),
        Number(appointment.lng),
      );
      if (meters > GEOFENCE_METERS) {
        throw new UnprocessableEntityException({ code: 'geofence_out_of_range' });
      }
    } else if (proof.code !== appointment.one_time_code) {
      throw new UnprocessableEntityException({ code: 'bad_code' });
    }

    await this.db.tx(async (ctx) => {
      await ctx.trx
        .insertInto('core.attendance_proof')
        .values({
          appointment_id: appointmentId,
          party,
          direction,
          method: proof.method,
          evidence: JSON.stringify(proof.location ?? {}),
          at: this.clock.now(),
        })
        .onConflict((oc) =>
          oc.columns(['appointment_id', 'party', 'direction']).doNothing(),
        )
        .execute();
      await ctx.emit({
        aggregateType: 'appointment',
        aggregateId: appointmentId,
        eventType: direction === 'check_in' ? 'appointment.checked_in' : 'appointment.checked_out',
        payload: { party, method: proof.method },
      });
    });

    if (party === 'agent' && direction === 'check_in' && appointment.state === 'confirmed') {
      await this.transition(appointmentId, 'in_progress');
    }
    if (party === 'agent' && direction === 'check_out' && appointment.state === 'in_progress') {
      await this.transition(appointmentId, 'completed');
    }
  }

  async recordFeedback(
    appointmentId: string,
    authorRole: 'agent' | 'viewer',
    structured: Record<string, unknown>,
    sharedWithOwner: boolean,
  ): Promise<void> {
    await this.db.kysely
      .insertInto('core.appointment_feedback')
      .values({
        appointment_id: appointmentId,
        author_role: authorRole,
        structured: JSON.stringify(structured),
        shared_with_owner: sharedWithOwner,
      })
      .onConflict((oc) => oc.columns(['appointment_id', 'author_role']).doNothing())
      .execute();
  }

  /** Outcome closes the loop back into the demand pipeline. */
  async recordOutcome(
    appointmentId: string,
    outcome: 'interested' | 'offer_intent' | 'rejected' | 'no_show_viewer',
    notes?: string,
  ): Promise<void> {
    const appointment = await this.db.kysely
      .selectFrom('core.appointment')
      .select(['id', 'state', 'viewer_contact_id', 'property_id'])
      .where('id', '=', appointmentId)
      .executeTakeFirst();
    if (!appointment) throw new NotFoundException({ code: 'appointment_not_found' });

    if (outcome === 'no_show_viewer') {
      await this.transition(appointmentId, 'no_show', { byParty: 'viewer' });
    } else {
      if (appointment.state === 'in_progress') {
        await this.transition(appointmentId, 'completed');
      }
      await this.transition(appointmentId, 'outcome_captured');
    }

    let routedItemId: string | null = null;
    if (outcome === 'interested' || outcome === 'offer_intent') {
      const { itemId } = await this.pipelines.recordInboundInquiry({
        contactId: appointment.viewer_contact_id,
        propertyId: appointment.property_id,
        payload: { via: 'viewing_outcome', outcome },
      });
      routedItemId = itemId;
    }

    await this.db.tx(async (ctx) => {
      await ctx.trx
        .insertInto('core.viewing_outcome')
        .values({
          appointment_id: appointmentId,
          outcome,
          notes: notes ?? null,
          routed_pipeline_item_id: routedItemId,
        })
        .onConflict((oc) => oc.column('appointment_id').doNothing())
        .execute();
      await ctx.emit({
        aggregateType: 'appointment',
        aggregateId: appointmentId,
        eventType: 'appointment.outcome_captured',
        payload: { outcome },
      });
    });
  }

  private isExclusionViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === '23P01'
    );
  }
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
