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
import { AppointmentsService } from '../appointments/appointments.service';

export const JOB_DISPATCH_START = 'dispatch.start';
export const JOB_OFFER_TTL = 'dispatch.offer_ttl';

interface DispatchConfig {
  strategy: 'waterfall' | 'broadcast' | 'hybrid';
  offerTtlSeconds: number;
  radiusInitialKm: number;
  radiusStepKm: number;
  waterfallRounds: number;
  maxConcurrentOffers: number;
  maxRungs: number;
  exclusivityDays: number;
  grantBufferBeforeHours: number;
  grantBufferAfterHours: number;
  weights: { distance: number; load: number; rating: number; language: number; fairness: number };
}

const DEFAULT_CONFIG: DispatchConfig = {
  strategy: 'hybrid',
  offerTtlSeconds: 120,
  radiusInitialKm: 10,
  radiusStepKm: 10,
  waterfallRounds: 3,
  maxConcurrentOffers: 8,
  maxRungs: 3,
  exclusivityDays: 30,
  grantBufferBeforeHours: 1,
  grantBufferAfterHours: 24,
  weights: { distance: 0.3, load: 0.2, rating: 0.2, language: 0.15, fairness: 0.15 },
};

export interface ClaimResult {
  agreement: {
    id: string;
    exclusivity_ends_at: string;
    terms_version: string;
  };
  appointment: Record<string, unknown>;
  contact_reveal_window_ends_at: string;
}

@Injectable()
export class DispatchService {
  private readonly config: DispatchConfig;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly appointments: AppointmentsService,
    @Optional() private readonly jobs?: JobScheduler,
    @Optional() nestConfig?: ConfigService,
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...(nestConfig?.get('DISPATCH_STRATEGY')
        ? { strategy: nestConfig.get('DISPATCH_STRATEGY') as DispatchConfig['strategy'] }
        : {}),
      ...(nestConfig?.get('OFFER_TTL_SECONDS')
        ? { offerTtlSeconds: Number(nestConfig.get('OFFER_TTL_SECONDS')) }
        : {}),
    };
  }

  /** Job handler for appointment.awaiting_agent → creates and starts a dispatch. */
  async startDispatch(appointmentId: string): Promise<string | null> {
    const appointment = await this.db.kysely
      .selectFrom('core.appointment')
      .select(['id', 'state', 'property_id'])
      .where('id', '=', appointmentId)
      .executeTakeFirst();
    if (!appointment || appointment.state !== 'dispatching') return null;

    const existing = await this.db.kysely
      .selectFrom('core.dispatch')
      .select('id')
      .where('appointment_id', '=', appointmentId)
      .where('state', 'in', ['pending', 'offering'])
      .executeTakeFirst();
    if (existing) return existing.id;

    const dispatchId = await this.db.tx(async (ctx) => {
      const row = await ctx.trx
        .insertInto('core.dispatch')
        .values({
          appointment_id: appointmentId,
          strategy: this.config.strategy,
          config_snapshot: JSON.stringify(this.config),
          state: 'pending',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await ctx.emit({
        aggregateType: 'dispatch',
        aggregateId: row.id,
        eventType: 'dispatch.started',
        payload: { strategy: this.config.strategy, appointment_id: appointmentId },
      });
      return row.id;
    });

    await this.rankCandidates(dispatchId, this.config.radiusInitialKm);
    await this.db.kysely
      .updateTable('core.dispatch')
      .set({ state: 'offering' })
      .where('id', '=', dispatchId)
      .execute();
    await this.progress(dispatchId);
    return dispatchId;
  }

  /**
   * Candidate ranking (hot path): active agents whose coverage reaches the
   * property, not absent, under capacity — scored on distance, load, rating,
   * language and recent-allocation fairness. Every candidate and component
   * is persisted (dispatch audit + Art 22 explainability).
   */
  private async rankCandidates(dispatchId: string, radiusKm: number): Promise<number> {
    const info = await this.db.kysely
      .selectFrom('core.dispatch as d')
      .innerJoin('core.appointment as a', 'a.id', 'd.appointment_id')
      .innerJoin('core.property as p', 'p.id', 'a.property_id')
      .innerJoin('core.contact as viewer', 'viewer.id', 'a.viewer_contact_id')
      .select([
        'd.id', 'a.id as appointment_id', 'p.id as property_id', 'viewer.locale',
        sql<string | null>`p.address_normalised->>'postcode'`.as('postcode'),
      ])
      .where('d.id', '=', dispatchId)
      .executeTakeFirstOrThrow();

    const rows = await sql<{
      agent_id: string;
      meters: string | null;
      load: string;
      capacity: number;
      languages: string[];
      recent_offers: string;
    }>`
      SELECT ap.contact_id AS agent_id,
             MIN(CASE WHEN ca.area IS NOT NULL
                 THEN ST_Distance(ca.area, p.geo_point) END)::text AS meters,
             (SELECT count(*) FROM core.appointment b
               WHERE b.agent_id = ap.contact_id
                 AND b.state IN ('booked','confirmed','in_progress'))::text AS load,
             ap.capacity_max_active AS capacity,
             ap.languages,
             (SELECT count(*) FROM core.dispatch_offer o
               WHERE o.agent_id = ap.contact_id
                 AND o.created_at > ${this.clock.now()}::timestamptz - interval '7 days')::text AS recent_offers
        FROM core.agent_profile ap
        JOIN core.coverage_area ca ON ca.agent_id = ap.contact_id
        JOIN core.appointment a ON a.id = ${info.appointment_id}
        JOIN core.property p ON p.id = a.property_id
       WHERE ap.state = 'active'
         AND (
           (ca.area IS NOT NULL AND p.geo_point IS NOT NULL
             AND ST_DWithin(ca.area, p.geo_point, ${radiusKm * 1000}))
           OR (ca.postcodes IS NOT NULL AND ${info.postcode ?? null} = ANY(ca.postcodes))
         )
         AND NOT EXISTS (SELECT 1 FROM core.agent_absence ab
               WHERE ab.agent_id = ap.contact_id AND ab.during && a.during)
       GROUP BY ap.contact_id, ap.capacity_max_active, ap.languages
    `.execute(this.db.kysely);

    const w = this.config.weights;
    const scored = rows.rows
      .filter((r) => Number(r.load) < r.capacity)
      .map((r) => {
        const meters = r.meters === null ? 0 : Number(r.meters);
        const components = {
          distance: w.distance * (1 - Math.min(meters / (radiusKm * 1000), 1)),
          load: w.load * (1 - Number(r.load) / r.capacity),
          rating: w.rating * 0.5, // neutral until the scorecard MV ships
          language: w.language * (r.languages.includes(info.locale) ? 1 : 0),
          fairness: w.fairness * (1 / (1 + Number(r.recent_offers))),
        };
        return {
          agentId: r.agent_id,
          components,
          score: Object.values(components).reduce((a, b) => a + b, 0),
        };
      })
      .sort((a, b) => b.score - a.score);

    let inserted = 0;
    for (const [i, candidate] of scored.entries()) {
      const row = await this.db.kysely
        .insertInto('core.dispatch_candidate')
        .values({
          dispatch_id: dispatchId,
          agent_id: candidate.agentId,
          rank: i + 1,
          score: candidate.score.toFixed(4),
          score_components: JSON.stringify(candidate.components),
        })
        .onConflict((oc) => oc.columns(['dispatch_id', 'agent_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (row) inserted++;
    }
    return inserted;
  }

  /** Advance the offer flow: send next offers, or escalate, or give up. */
  async progress(dispatchId: string): Promise<void> {
    const dispatch = await this.db.kysely
      .selectFrom('core.dispatch')
      .selectAll()
      .where('id', '=', dispatchId)
      .executeTakeFirstOrThrow();
    if (dispatch.state !== 'offering') return;

    const live = await this.db.kysely
      .selectFrom('core.dispatch_offer')
      .select('id')
      .where('dispatch_id', '=', dispatchId)
      .where('state', 'in', ['sent', 'seen'])
      .execute();
    if (live.length > 0) return; // an offer is on the table; wait for it

    const unoffered = await this.db.kysely
      .selectFrom('core.dispatch_candidate as c')
      .leftJoin('core.dispatch_offer as o', (join) =>
        join.onRef('o.dispatch_id', '=', 'c.dispatch_id').onRef('o.agent_id', '=', 'c.agent_id'),
      )
      .select(['c.agent_id', 'c.rank'])
      .where('c.dispatch_id', '=', dispatchId)
      .where('o.id', 'is', null)
      .orderBy('c.rank')
      .execute();

    if (unoffered.length === 0) {
      await this.escalate(dispatch);
      return;
    }

    const sent = await this.db.kysely
      .selectFrom('core.dispatch_offer')
      .select(this.db.kysely.fn.countAll().as('n'))
      .where('dispatch_id', '=', dispatchId)
      .executeTakeFirstOrThrow();
    const alreadySent = Number(sent.n);
    const batchSize =
      dispatch.strategy === 'broadcast'
        ? this.config.maxConcurrentOffers
        : dispatch.strategy === 'waterfall'
          ? 1
          : alreadySent < this.config.waterfallRounds
            ? 1
            : this.config.maxConcurrentOffers;

    const now = this.clock.now();
    const ttl = new Date(now.getTime() + this.config.offerTtlSeconds * 1000);
    for (const candidate of unoffered.slice(0, batchSize)) {
      const offer = await this.db.tx(async (ctx) => {
        const row = await ctx.trx
          .insertInto('core.dispatch_offer')
          .values({
            dispatch_id: dispatchId,
            agent_id: candidate.agent_id,
            ttl_expires_at: ttl,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await ctx.emit({
          aggregateType: 'dispatch',
          aggregateId: dispatchId,
          eventType: 'dispatch.offer_sent',
          payload: { offer_id: row.id, agent_id: candidate.agent_id, ttl_expires_at: ttl.toISOString() },
        });
        return row;
      });
      await this.jobs?.schedule(
        JOB_OFFER_TTL,
        { offerId: offer.id },
        ttl,
        { dedupeId: `offer_ttl:${offer.id}` },
      );
    }
  }

  private async escalate(dispatch: {
    id: string;
    escalation_rung: number;
    appointment_id: string;
  }): Promise<void> {
    const rung = dispatch.escalation_rung + 1;
    if (rung <= this.config.maxRungs) {
      const radius = this.config.radiusInitialKm + rung * this.config.radiusStepKm;
      await this.db.tx(async (ctx) => {
        await ctx.trx
          .updateTable('core.dispatch')
          .set({ escalation_rung: rung })
          .where('id', '=', dispatch.id)
          .execute();
        await ctx.emit({
          aggregateType: 'dispatch',
          aggregateId: dispatch.id,
          eventType: 'dispatch.escalated',
          payload: {
            rung: rung >= this.config.maxRungs ? 'ops_alert' : 'widen_radius',
            radius_km: radius,
          },
        });
      });
      const added = await this.rankCandidates(dispatch.id, radius);
      if (added > 0) {
        await this.progress(dispatch.id);
        return;
      }
      if (rung < this.config.maxRungs) {
        // Nothing new this ring; try the next one immediately.
        const fresh = await this.db.kysely
          .selectFrom('core.dispatch')
          .selectAll()
          .where('id', '=', dispatch.id)
          .executeTakeFirstOrThrow();
        await this.escalate(fresh);
        return;
      }
    }

    // Ladder exhausted → no-agent fallback path.
    await this.db.tx(async (ctx) => {
      await ctx.trx
        .updateTable('core.dispatch')
        .set({ state: 'no_agent' })
        .where('id', '=', dispatch.id)
        .where('state', '=', 'offering')
        .execute();
      await ctx.emit({
        aggregateType: 'dispatch',
        aggregateId: dispatch.id,
        eventType: 'dispatch.no_agent',
        payload: {},
      });
    });
    await this.appointments.transition(dispatch.appointment_id, 'unstaffed');
  }

  /**
   * THE ATOMIC CLAIM. One conditional UPDATE decides the winner; everything
   * else — agreement, attribution, access grant, sibling withdrawal,
   * appointment assignment — rides in the winner's transaction. Losers get
   * a clean 409; the winner's retry is an idempotent replay. Online-only:
   * offline replays are rejected at the controller.
   */
  async claim(
    offerId: string,
    agentId: string,
    context: { ip?: string; deviceFingerprint?: string } = {},
  ): Promise<ClaimResult> {
    const now = this.clock.now();
    const offer = await this.db.kysely
      .selectFrom('core.dispatch_offer')
      .selectAll()
      .where('id', '=', offerId)
      .executeTakeFirst();
    if (!offer || offer.agent_id !== agentId) {
      throw new NotFoundException({ code: 'offer_not_found' });
    }

    const dispatch = await this.db.kysely
      .selectFrom('core.dispatch')
      .selectAll()
      .where('id', '=', offer.dispatch_id)
      .executeTakeFirstOrThrow();

    // Idempotent replay: this offer already won.
    if (dispatch.winning_offer_id === offerId) {
      return this.claimResult(offerId);
    }
    if (offer.state === 'withdrawn' || dispatch.state === 'cancelled') {
      throw new ConflictException({ code: 'offer_withdrawn' });
    }
    if (offer.state === 'expired' || offer.ttl_expires_at.getTime() <= now.getTime()) {
      throw new GoneException({ code: 'offer_expired' });
    }
    if (offer.state === 'declined') {
      throw new ConflictException({ code: 'offer_withdrawn' });
    }

    const cancelJobs: string[] = [];
    try {
      await this.db.tx(async (ctx) => {
        const won = await ctx.trx
          .updateTable('core.dispatch')
          .set({ state: 'claimed', winning_offer_id: offerId, claimed_at: now })
          .where('id', '=', offer.dispatch_id)
          .where('state', '=', 'offering')
          .where('winning_offer_id', 'is', null)
          .executeTakeFirst();

        if (won.numUpdatedRows === 0n) {
          throw new ConflictException({ code: 'already_claimed' });
        }

        await ctx.trx
          .updateTable('core.dispatch_offer')
          .set({ state: 'claimed', responded_at: now })
          .where('id', '=', offerId)
          .execute();
        const siblings = await ctx.trx
          .updateTable('core.dispatch_offer')
          .set({ state: 'withdrawn' })
          .where('dispatch_id', '=', offer.dispatch_id)
          .where('id', '<>', offerId)
          .where('state', 'in', ['sent', 'seen'])
          .returning('id')
          .execute();
        cancelJobs.push(...siblings.map((s) => `offer_ttl:${s.id}`), `offer_ttl:${offerId}`);

        // Assign the agent; the agent-overlap exclusion constraint makes a
        // double-booked agent roll the whole claim back.
        const appointment = await ctx.trx
          .selectFrom('core.appointment')
          .select(['id', 'viewer_contact_id', 'property_id',
            sql<Date>`lower(during)`.as('starts_at'),
            sql<Date>`upper(during)`.as('ends_at')])
          .where('id', '=', dispatch.appointment_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await ctx.trx
          .updateTable('core.appointment')
          .set({ agent_id: agentId, state: 'booked' })
          .where('id', '=', appointment.id)
          .execute();
        await ctx.emit({
          aggregateType: 'appointment',
          aggregateId: appointment.id,
          eventType: 'appointment.state_changed',
          payload: { from: 'dispatching', to: 'booked' },
        });

        const profile = await ctx.trx
          .selectFrom('core.agent_profile')
          .select('commission_terms')
          .where('contact_id', '=', agentId)
          .executeTakeFirstOrThrow();
        const terms = await ctx.trx
          .selectFrom('core.terms_version')
          .select(['id', 'version'])
          .orderBy('version', 'desc')
          .limit(1)
          .executeTakeFirstOrThrow();
        const exclusivityEndsAt = new Date(
          appointment.starts_at.getTime() +
            this.config.exclusivityDays * 24 * 3_600_000,
        );
        const agreement = await ctx.trx
          .insertInto('core.assignment_agreement')
          .values({
            offer_id: offerId,
            agent_id: agentId,
            appointment_id: appointment.id,
            terms_snapshot: JSON.stringify({
              commission_terms: profile.commission_terms,
              terms_version: terms.version,
            }),
            terms_version_id: terms.id,
            accepted_at: now,
            ip: context.ip ?? null,
            device_fingerprint: context.deviceFingerprint ?? null,
            exclusivity_ends_at: exclusivityEndsAt,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await ctx.trx
          .insertInto('core.attribution')
          .values({
            agreement_id: agreement.id,
            buyer_contact_id: appointment.viewer_contact_id,
            property_id: appointment.property_id,
            window_ends_at: exclusivityEndsAt,
          })
          .execute();
        await ctx.trx
          .insertInto('core.lead_touch')
          .values({
            agent_id: agentId,
            buyer_contact_id: appointment.viewer_contact_id,
            property_id: appointment.property_id,
            kind: 'claim',
            at: now,
          })
          .execute();

        // Purpose-bound temporal grant: full contact details only around
        // this appointment; the revocation sweep (#24) enforces the end.
        await ctx.trx
          .insertInto('core.access_grant')
          .values({
            grantee_agent_id: agentId,
            subject_contact_id: appointment.viewer_contact_id,
            appointment_id: appointment.id,
            during: sql`tstzrange(${new Date(appointment.starts_at.getTime() - this.config.grantBufferBeforeHours * 3_600_000)}, ${new Date(appointment.ends_at.getTime() + this.config.grantBufferAfterHours * 3_600_000)})`,
          })
          .execute();

        await ctx.emit({
          aggregateType: 'dispatch',
          aggregateId: offer.dispatch_id,
          eventType: 'dispatch.claimed',
          payload: { agreement_id: agreement.id, agent_id: agentId },
        });
        await ctx.emit({
          aggregateType: 'agreement',
          aggregateId: agreement.id,
          eventType: 'agreement.created',
          payload: { exclusivity_ends_at: exclusivityEndsAt.toISOString() },
        });
        for (const sibling of siblings) {
          await ctx.emit({
            aggregateType: 'dispatch',
            aggregateId: offer.dispatch_id,
            eventType: 'dispatch.offer_resolved',
            payload: { offer_id: sibling.id, resolution: 'withdrawn' },
          });
        }
      });
    } catch (err) {
      if (err instanceof ConflictException) {
        // Lost the race — double-check for the idempotent-replay edge where
        // OUR offer won in a concurrent request.
        const check = await this.db.kysely
          .selectFrom('core.dispatch')
          .select('winning_offer_id')
          .where('id', '=', offer.dispatch_id)
          .executeTakeFirstOrThrow();
        if (check.winning_offer_id === offerId) return this.claimResult(offerId);
        throw new ConflictException({ code: 'already_claimed' });
      }
      if (this.isExclusionViolation(err)) {
        throw new ConflictException({ code: 'schedule_conflict' });
      }
      throw err;
    }

    for (const dedupeId of cancelJobs) await this.jobs?.cancel(dedupeId);
    return this.claimResult(offerId);
  }

  private async claimResult(offerId: string): Promise<ClaimResult> {
    const agreement = await this.db.kysely
      .selectFrom('core.assignment_agreement as ag')
      .innerJoin('core.terms_version as tv', 'tv.id', 'ag.terms_version_id')
      .select(['ag.id', 'ag.appointment_id', 'ag.exclusivity_ends_at', 'tv.version'])
      .where('ag.offer_id', '=', offerId)
      .executeTakeFirstOrThrow();
    const grant = await this.db.kysely
      .selectFrom('core.access_grant')
      .select(sql<Date>`upper(during)`.as('window_end'))
      .where('appointment_id', '=', agreement.appointment_id)
      .where('revoked_at', 'is', null)
      .executeTakeFirstOrThrow();
    return {
      agreement: {
        id: agreement.id,
        exclusivity_ends_at: agreement.exclusivity_ends_at.toISOString(),
        terms_version: String(agreement.version),
      },
      appointment: await this.appointments.getAppointment(agreement.appointment_id),
      contact_reveal_window_ends_at: grant.window_end.toISOString(),
    };
  }

  async decline(offerId: string, agentId: string): Promise<void> {
    const offer = await this.db.kysely
      .selectFrom('core.dispatch_offer')
      .selectAll()
      .where('id', '=', offerId)
      .executeTakeFirst();
    if (!offer || offer.agent_id !== agentId) {
      throw new NotFoundException({ code: 'offer_not_found' });
    }
    if (!['sent', 'seen'].includes(offer.state)) {
      throw new ConflictException({ code: 'state_conflict' });
    }
    await this.db.tx(async (ctx) => {
      await ctx.trx
        .updateTable('core.dispatch_offer')
        .set({ state: 'declined', responded_at: this.clock.now() })
        .where('id', '=', offerId)
        .where('state', 'in', ['sent', 'seen'])
        .execute();
      await ctx.emit({
        aggregateType: 'dispatch',
        aggregateId: offer.dispatch_id,
        eventType: 'dispatch.offer_resolved',
        payload: { offer_id: offerId, resolution: 'declined' },
      });
    });
    await this.jobs?.cancel(`offer_ttl:${offerId}`);
    await this.progress(offer.dispatch_id);
  }

  /** Job handler: TTL lapse expires the offer and advances the flow. */
  async expireOffer(offerId: string): Promise<void> {
    const now = this.clock.now();
    const offer = await this.db.kysely
      .selectFrom('core.dispatch_offer')
      .selectAll()
      .where('id', '=', offerId)
      .executeTakeFirst();
    if (!offer || !['sent', 'seen'].includes(offer.state)) return;
    if (offer.ttl_expires_at.getTime() > now.getTime()) return;

    await this.db.tx(async (ctx) => {
      const updated = await ctx.trx
        .updateTable('core.dispatch_offer')
        .set({ state: 'expired' })
        .where('id', '=', offerId)
        .where('state', 'in', ['sent', 'seen'])
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) return;
      await ctx.emit({
        aggregateType: 'dispatch',
        aggregateId: offer.dispatch_id,
        eventType: 'dispatch.offer_resolved',
        payload: { offer_id: offerId, resolution: 'expired' },
      });
    });
    await this.progress(offer.dispatch_id);
  }

  /** Agent-facing open offers with the pre-claim (PII-free) summary. */
  async listOffers(agentId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.db.kysely
      .selectFrom('core.dispatch_offer as o')
      .innerJoin('core.dispatch as d', 'd.id', 'o.dispatch_id')
      .innerJoin('core.appointment as a', 'a.id', 'd.appointment_id')
      .innerJoin('core.property as p', 'p.id', 'a.property_id')
      .innerJoin('core.listing as l', 'l.id', 'a.listing_id')
      .select([
        'o.id', 'o.state', 'o.ttl_expires_at', 'l.channel', 'p.kind',
        sql<Date>`lower(a.during)`.as('starts_at'),
        sql<Date>`upper(a.during)`.as('ends_at'),
        sql<string | null>`p.address_normalised->>'postcode'`.as('postcode'),
        sql<string | null>`p.address_normalised->>'city'`.as('city'),
        sql<string | null>`ST_Y(p.geo_point::geometry)::text`.as('lat'),
        sql<string | null>`ST_X(p.geo_point::geometry)::text`.as('lng'),
      ])
      .where('o.agent_id', '=', agentId)
      .where('o.state', 'in', ['sent', 'seen'])
      .where('o.ttl_expires_at', '>', this.clock.now())
      .orderBy('o.ttl_expires_at')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      state: r.state,
      ttl_expires_at: r.ttl_expires_at.toISOString(),
      appointment_summary: {
        starts_at: r.starts_at.toISOString(),
        ends_at: r.ends_at.toISOString(),
        area_label: [r.postcode, r.city].filter(Boolean).join(' '),
        approx_location:
          r.lat && r.lng ? { lat: Number(r.lat), lng: Number(r.lng) } : null,
        property_kind: r.kind,
        channel: r.channel,
      },
    }));
  }

  private isExclusionViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === '23P01'
    );
  }
}
