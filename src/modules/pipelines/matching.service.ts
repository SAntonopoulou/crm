import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { Db } from '../../shared/database/db.service';
import { systemClock } from '../../shared/jobs/clock';

export const JOB_EVALUATE_LISTING = 'matching.evaluate_listing';

/**
 * Match engine (domain model §5): evaluates a listing against all active
 * requirement profiles. Respects processing_restricted (Art 18 freeze) and
 * excludes erased contacts. New matches emit match.created for the
 * notification module's alert fan-out.
 */
@Injectable()
export class MatchingService {
  constructor(private readonly db: Db) {}

  async evaluateListing(listingId: string): Promise<number> {
    const listing = await this.db.kysely
      .selectFrom('core.listing as l')
      .innerJoin('core.property as p', 'p.id', 'l.property_id')
      .select([
        'l.id',
        'l.channel',
        'l.price',
        'l.state',
        'p.bedrooms',
        'p.id as property_id',
        sql<string | null>`p.address_normalised->>'postcode'`.as('postcode'),
        sql<boolean>`p.geo_point IS NOT NULL`.as('has_geo'),
      ])
      .where('l.id', '=', listingId)
      .executeTakeFirst();
    if (!listing || listing.state !== 'live') return 0;

    // Profile filter: channel, budget band, bedrooms, geography (polygon
    // containment OR postcode list), and the privacy gates.
    const candidates = await this.db.kysely
      .selectFrom('core.requirement_profile as r')
      .innerJoin('core.contact as c', 'c.id', 'r.contact_id')
      .select(['r.id', 'r.budget_min', 'r.budget_max', 'r.bedrooms_min'])
      .where('r.active', '=', true)
      .where('r.channel', '=', listing.channel)
      .where('c.processing_restricted', '=', false)
      .where('c.lifecycle_state', '<>', 'erased')
      .where((eb) =>
        eb.or([
          eb(
            sql<boolean>`(r.postcodes IS NOT NULL AND ${listing.postcode ?? null} = ANY(r.postcodes))`,
            '=',
            true,
          ),
          eb(
            sql<boolean>`(r.areas IS NOT NULL AND ST_Covers(r.areas, (SELECT geo_point FROM core.property WHERE id = ${listing.property_id})))`,
            '=',
            true,
          ),
        ]),
      )
      .execute();

    let created = 0;
    for (const profile of candidates) {
      if (listing.price !== null) {
        if (profile.budget_min !== null && Number(listing.price) < Number(profile.budget_min)) continue;
        if (profile.budget_max !== null && Number(listing.price) > Number(profile.budget_max)) continue;
      }
      if (
        profile.bedrooms_min !== null &&
        (listing.bedrooms === null || listing.bedrooms < profile.bedrooms_min)
      ) {
        continue;
      }

      const score = this.score(listing, profile);
      const inserted = await this.db.tx(async (ctx) => {
        const row = await ctx.trx
          .insertInto('core.match')
          .values({ profile_id: profile.id, listing_id: listing.id, score })
          .onConflict((oc) => oc.columns(['profile_id', 'listing_id']).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (row) {
          await ctx.emit({
            aggregateType: 'match',
            aggregateId: row.id,
            eventType: 'match.created',
            payload: { profile_id: profile.id, listing_id: listing.id, score },
          });
        }
        return row !== undefined;
      });
      if (inserted) created++;
    }
    return created;
  }

  async recordFeedback(
    matchId: string,
    contactId: string,
    feedback: 'dismissed' | 'interested',
  ): Promise<void> {
    await this.db.tx(async (ctx) => {
      const match = await ctx.trx
        .selectFrom('core.match as m')
        .innerJoin('core.requirement_profile as r', 'r.id', 'm.profile_id')
        .select(['m.id'])
        .where('m.id', '=', matchId)
        .where('r.contact_id', '=', contactId)
        .executeTakeFirst();
      if (!match) throw new NotFoundException({ code: 'match_not_found' });

      await ctx.trx
        .updateTable('core.match')
        .set({
          state: feedback,
          feedback: JSON.stringify({ feedback, at: systemClock.now().toISOString() }),
        })
        .where('id', '=', matchId)
        .execute();
      await ctx.emit({
        aggregateType: 'match',
        aggregateId: matchId,
        eventType: 'match.feedback_recorded',
        payload: { feedback },
      });
    });
  }

  private score(
    listing: { price: string | null; bedrooms: number | null },
    profile: { budget_max: string | null; bedrooms_min: number | null },
  ): number {
    let score = 50;
    // Under budget scores higher; exact bedroom fit scores higher.
    if (listing.price !== null && profile.budget_max !== null) {
      const headroom = 1 - Number(listing.price) / Number(profile.budget_max);
      score += Math.max(0, Math.min(30, Math.round(headroom * 100)));
    }
    if (
      listing.bedrooms !== null &&
      profile.bedrooms_min !== null &&
      listing.bedrooms >= profile.bedrooms_min
    ) {
      score += 10;
    }
    return Math.min(100, score);
  }
}
