import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Db } from '../../shared/database/db.service';

export interface ValueEstimate {
  amount: string;
  currency: string;
}

/**
 * Comparable-based valuation, methodology decided 2026-08-09 (adaptive
 * radius): comps share property_kind, floor area ±30%, are live or
 * sold/let within 12 months; start at 2 km, expand to 5 km only when the
 * 2 km ring has fewer than MIN_COMPS; below MIN_COMPS at 5 km → NO
 * estimate (absent, never null-as-zero). Estimate = median EUR/m² ×
 * subject floor area; yield = median comparable monthly rent × 12 / price.
 */
const MIN_COMPS = 5;
const RADII_KM = [2, 5] as const;
const RECENCY = '12 months';

interface CompStats {
  median: string | null;
  n: string;
}

@Injectable()
export class ValuationService {
  constructor(private readonly db: Db) {}

  /** Median sale EUR/m² × subject area, or undefined (absent). */
  async estimateValue(propertyId: string): Promise<ValueEstimate | undefined> {
    const subject = await this.db.kysely
      .selectFrom('core.property')
      .select(['id', 'kind', 'floor_area_sqm'])
      .where('id', '=', propertyId)
      .where('geo_point', 'is not', null)
      .executeTakeFirst();
    if (!subject?.kind || !subject.floor_area_sqm) return undefined;

    for (const radiusKm of RADII_KM) {
      const stats = await this.saleCompStats(subject.id, subject.kind, Number(subject.floor_area_sqm), radiusKm);
      if (Number(stats.n) >= MIN_COMPS && stats.median !== null) {
        const amount = Number(stats.median) * Number(subject.floor_area_sqm);
        return { amount: amount.toFixed(2), currency: 'EUR' };
      }
    }
    return undefined;
  }

  /** Median comparable monthly rent × 12 / listing price, as a percentage. */
  async estimateYieldPercent(listingId: string): Promise<number | null> {
    const listing = await this.db.kysely
      .selectFrom('core.listing as l')
      .innerJoin('core.property as p', 'p.id', 'l.property_id')
      .select(['l.price', 'p.id as property_id', 'p.kind', 'p.floor_area_sqm'])
      .where('l.id', '=', listingId)
      .where('l.channel', '=', 'sale')
      .executeTakeFirst();
    if (!listing?.price || !listing.kind || !listing.floor_area_sqm) return null;

    for (const radiusKm of RADII_KM) {
      const stats = await this.rentCompStats(
        listing.property_id,
        listing.kind,
        Number(listing.floor_area_sqm),
        radiusKm,
      );
      if (Number(stats.n) >= MIN_COMPS && stats.median !== null) {
        const yearly = Number(stats.median) * 12;
        return Number(((yearly / Number(listing.price)) * 100).toFixed(2));
      }
    }
    return null;
  }

  private async saleCompStats(
    propertyId: string,
    kind: string,
    area: number,
    radiusKm: number,
  ): Promise<CompStats> {
    const res = await sql<CompStats>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY l.price / p.floor_area_sqm)::text AS median,
             count(*)::text AS n
        FROM core.listing l
        JOIN core.property p ON p.id = l.property_id
       WHERE l.channel = 'sale'
         AND l.price IS NOT NULL
         AND p.floor_area_sqm IS NOT NULL AND p.floor_area_sqm > 0
         AND p.kind = ${kind}
         AND p.id <> ${propertyId}
         AND p.floor_area_sqm BETWEEN ${area * 0.7} AND ${area * 1.3}
         AND (l.state = 'live'
              OR (l.state IN ('sold','let') AND l.state_entered_at > now() - ${RECENCY}::interval))
         AND ST_DWithin(
               p.geo_point,
               (SELECT geo_point FROM core.property WHERE id = ${propertyId}),
               ${radiusKm * 1000})
    `.execute(this.db.kysely);
    return res.rows[0];
  }

  private async rentCompStats(
    propertyId: string,
    kind: string,
    area: number,
    radiusKm: number,
  ): Promise<CompStats> {
    const res = await sql<CompStats>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY l.price)::text AS median,
             count(*)::text AS n
        FROM core.listing l
        JOIN core.property p ON p.id = l.property_id
       WHERE l.channel = 'rent'
         AND l.price IS NOT NULL
         AND p.floor_area_sqm IS NOT NULL AND p.floor_area_sqm > 0
         AND p.kind = ${kind}
         AND p.id <> ${propertyId}
         AND p.floor_area_sqm BETWEEN ${area * 0.7} AND ${area * 1.3}
         AND (l.state = 'live'
              OR (l.state IN ('sold','let') AND l.state_entered_at > now() - ${RECENCY}::interval))
         AND ST_DWithin(
               p.geo_point,
               (SELECT geo_point FROM core.property WHERE id = ${propertyId}),
               ${radiusKm * 1000})
    `.execute(this.db.kysely);
    return res.rows[0];
  }
}
