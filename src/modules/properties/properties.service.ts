import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { Db, TxContext } from '../../shared/database/db.service';
import { Clock } from '../../shared/jobs/clock';
import { JobScheduler } from '../../shared/jobs/job-scheduler';
import {
  ProvenanceResolver,
  ProvenanceMethod,
} from '../../shared/provenance/provenance-resolver';
import { listingLifecycle, ListingState } from './listing-lifecycle';
import {
  AddressInput,
  canonicalKey,
  normaliseAddress,
  normaliseEpc,
} from './normalise';

export interface PropertyPayload {
  address: AddressInput;
  attributes?: {
    kind?: string;
    floor_area_sqm?: number;
    bedrooms?: number;
    epc_rating?: string;
    tenure?: string;
    occupancy?: string;
    [key: string]: unknown;
  };
  listing?: {
    channel?: 'sale' | 'rent';
    price?: string;
    currency?: string;
    description?: string;
    source_url?: string;
  };
  media?: { url: string; caption?: string; position?: number }[];
}

export interface UpsertResult {
  propertyId: string;
  listingId?: string;
  created: boolean;
}

interface ProvenanceMeta {
  method: ProvenanceMethod;
  confidence?: number;
  collectedAt: Date;
  sourceId: string;
}

const STRUCTURED_KEYS = new Set([
  'kind',
  'floor_area_sqm',
  'bedrooms',
  'epc_rating',
  'tenure',
  'occupancy',
]);
const PROPERTY_KINDS = new Set(['house', 'apartment', 'land', 'commercial', 'other']);
const OCCUPANCIES = new Set(['vacant', 'owner_occupied', 'tenanted']);
const TENURES = new Set(['freehold', 'leasehold', 'unknown']);
const TERMINAL_LISTING_STATES = ['sold', 'let', 'withdrawn', 'expired'];

@Injectable()
export class PropertiesService {
  private readonly deepLinkBase: string;

  constructor(
    private readonly db: Db,
    private readonly resolver: ProvenanceResolver,
    config: ConfigService,
    @Optional() private readonly jobs?: JobScheduler,
    @Optional() private readonly clock?: Clock,
  ) {
    this.deepLinkBase = config.get<string>('DEEP_LINK_BASE') ?? 'https://app.example/l';
  }

  /**
   * Listing lifecycle transition. Going `live` schedules match evaluation
   * through the job registry — pipelines register the handler, so there is
   * no properties→pipelines import cycle.
   */
  async transitionListing(
    listingId: string,
    to: ListingState,
    actorId: string | null,
  ): Promise<void> {
    const now = this.clock?.now() ?? new Date();
    await this.db.tx(async (ctx) => {
      const listing = await ctx.trx
        .selectFrom('core.listing')
        .select(['id', 'state', 'channel'])
        .where('id', '=', listingId)
        .forUpdate()
        .executeTakeFirst();
      if (!listing) throw new NotFoundException({ code: 'listing_not_found' });

      const from = listing.state as ListingState;
      listingLifecycle.assert(from, to);

      await ctx.trx
        .updateTable('core.listing')
        .set({ state: to, state_entered_at: now })
        .where('id', '=', listingId)
        .execute();
      await ctx.trx
        .insertInto('core.listing_change')
        .values({
          listing_id: listingId,
          field: 'state',
          old_value: JSON.stringify(from),
          new_value: JSON.stringify(to),
        })
        .execute();
      await ctx.emit({
        aggregateType: 'listing',
        aggregateId: listingId,
        eventType: 'listing.state_changed',
        payload: { from, to, channel: listing.channel, actor_id: actorId },
      });
      if (to === 'live') {
        await ctx.emit({
          aggregateType: 'listing',
          aggregateId: listingId,
          eventType: 'listing.published',
          payload: { channel: listing.channel },
        });
      }
    });
    if (to === 'live') {
      await this.jobs?.schedule('matching.evaluate_listing', { listingId }, now);
    }
  }

  /**
   * Provenance-aware upsert used by ingest and (later) owner self-serve.
   * Every structured field goes through the resolver: lower-precedence
   * writes park as candidates instead of overwriting.
   */
  async upsertFromPayload(
    ctx: TxContext,
    payload: PropertyPayload,
    prov: ProvenanceMeta,
  ): Promise<UpsertResult> {
    const address = normaliseAddress(payload.address);
    const key = canonicalKey(address);

    let created = false;
    let property = await ctx.trx
      .selectFrom('core.property')
      .select(['id', 'merged_into'])
      .where('canonical_key', '=', key)
      .forUpdate()
      .executeTakeFirst();

    let propertyId: string;
    if (!property) {
      created = true;
      const row = await ctx.trx
        .insertInto('core.property')
        .values({
          canonical_key: key,
          address_normalised: JSON.stringify(address),
          timezone: 'Europe/Brussels',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      propertyId = row.id;
      await ctx.emit({
        aggregateType: 'property',
        aggregateId: propertyId,
        eventType: 'property.created',
        payload: {},
      });
    } else {
      propertyId = property.merged_into ?? property.id;
    }

    const attrs = payload.attributes ?? {};
    const updates: Record<string, unknown> = {};
    const freeAttrs: Record<string, unknown> = {};
    const changedFields: string[] = [];

    const consider = async (field: string, value: unknown) => {
      if (value === undefined || value === null) return;
      const res = await this.resolver.resolve(ctx.trx, {
        entityType: 'property',
        entityId: propertyId,
        field,
        value,
        method: prov.method,
        confidence: prov.confidence,
        sourceId: prov.sourceId,
        collectedAt: prov.collectedAt,
      });
      if (res.applied) {
        updates[field] = value;
        changedFields.push(field);
      }
    };

    const kind = attrs.kind && PROPERTY_KINDS.has(attrs.kind) ? attrs.kind : undefined;
    await consider('kind', kind);
    await consider('floor_area_sqm', attrs.floor_area_sqm);
    await consider('bedrooms', attrs.bedrooms);
    const epc = normaliseEpc(attrs.epc_rating);
    await consider('epc_rating', epc);
    if (attrs.epc_rating && !epc) {
      // Unparseable raw label: parked for review, never force-cast.
      freeAttrs['epc_raw'] = attrs.epc_rating;
    }
    await consider('tenure', attrs.tenure && TENURES.has(attrs.tenure) ? attrs.tenure : undefined);
    await consider(
      'occupancy',
      attrs.occupancy && OCCUPANCIES.has(attrs.occupancy) ? attrs.occupancy : undefined,
    );

    for (const [k, v] of Object.entries(attrs)) {
      if (!STRUCTURED_KEYS.has(k) && v !== undefined && v !== null) freeAttrs[k] = v;
    }

    if (Object.keys(updates).length > 0 || Object.keys(freeAttrs).length > 0) {
      await ctx.trx
        .updateTable('core.property')
        .set({
          ...updates,
          ...(Object.keys(freeAttrs).length > 0
            ? {
                free_attributes: sql`free_attributes || ${JSON.stringify(freeAttrs)}::jsonb`,
              }
            : {}),
        })
        .where('id', '=', propertyId)
        .execute();
      if (!created && changedFields.length > 0) {
        await ctx.emit({
          aggregateType: 'property',
          aggregateId: propertyId,
          eventType: 'property.updated',
          payload: { changed_fields: changedFields },
        });
      }
    }

    let listingId: string | undefined;
    if (payload.listing?.channel) {
      listingId = await this.upsertListing(ctx, propertyId, payload.listing, prov);
    }

    if (payload.media?.length) {
      for (const m of payload.media) {
        const exists = await ctx.trx
          .selectFrom('core.media_asset')
          .select('id')
          .where('property_id', '=', propertyId)
          .where('url', '=', m.url)
          .executeTakeFirst();
        if (!exists) {
          await ctx.trx
            .insertInto('core.media_asset')
            .values({
              property_id: propertyId,
              listing_id: listingId ?? null,
              url: m.url,
              caption: m.caption ?? null,
              position: m.position ?? 0,
            })
            .execute();
        }
      }
    }

    return { propertyId, listingId, created };
  }

  private async upsertListing(
    ctx: TxContext,
    propertyId: string,
    listing: NonNullable<PropertyPayload['listing']>,
    prov: ProvenanceMeta,
  ): Promise<string> {
    const active = await ctx.trx
      .selectFrom('core.listing')
      .select(['id', 'price', 'currency', 'description', 'state'])
      .where('property_id', '=', propertyId)
      .where('channel', '=', listing.channel!)
      .where('state', 'not in', TERMINAL_LISTING_STATES)
      .forUpdate()
      .executeTakeFirst();

    if (!active) {
      const row = await ctx.trx
        .insertInto('core.listing')
        .values({
          property_id: propertyId,
          channel: listing.channel!,
          price: listing.price ?? null,
          currency: listing.currency ?? 'EUR',
          description: listing.description ?? null,
          source_url: listing.source_url ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await ctx.emit({
        aggregateType: 'listing',
        aggregateId: row.id,
        eventType: 'listing.state_changed',
        payload: { from: null, to: 'discovered', channel: listing.channel },
      });
      return row.id;
    }

    if (listing.price !== undefined && listing.price !== null) {
      const res = await this.resolver.resolve(ctx.trx, {
        entityType: 'listing',
        entityId: active.id,
        field: 'price',
        value: listing.price,
        method: prov.method,
        confidence: prov.confidence,
        sourceId: prov.sourceId,
        collectedAt: prov.collectedAt,
      });
      const oldPrice = active.price === null ? null : String(active.price);
      if (res.applied && oldPrice !== listing.price) {
        await ctx.trx
          .updateTable('core.listing')
          .set({ price: listing.price })
          .where('id', '=', active.id)
          .execute();
        await ctx.trx
          .insertInto('core.listing_change')
          .values({
            listing_id: active.id,
            field: 'price',
            old_value: JSON.stringify(oldPrice),
            new_value: JSON.stringify(listing.price),
          })
          .execute();
        await ctx.emit({
          aggregateType: 'listing',
          aggregateId: active.id,
          eventType: 'listing.price_changed',
          payload: { old: oldPrice, new: listing.price, currency: active.currency },
        });
      }
    }

    if (listing.description !== undefined && listing.description !== null) {
      const res = await this.resolver.resolve(ctx.trx, {
        entityType: 'listing',
        entityId: active.id,
        field: 'description',
        value: listing.description,
        method: prov.method,
        confidence: prov.confidence,
        sourceId: prov.sourceId,
        collectedAt: prov.collectedAt,
      });
      if (res.applied && active.description !== listing.description) {
        await ctx.trx
          .updateTable('core.listing')
          .set({ description: listing.description })
          .where('id', '=', active.id)
          .execute();
        await ctx.trx
          .insertInto('core.listing_change')
          .values({
            listing_id: active.id,
            field: 'description',
            old_value: JSON.stringify(active.description),
            new_value: JSON.stringify(listing.description),
          })
          .execute();
      }
    }

    return active.id;
  }

  /** Contract: GET /v1/listings — live listings only. */
  async search(params: {
    channel?: 'sale' | 'rent';
    lat?: number;
    lng?: number;
    radius_km?: number;
    postcodes?: string[];
    price_min?: string;
    price_max?: string;
    bedrooms_min?: number;
    property_kind?: string;
    occupancy?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ items: unknown[]; next_cursor: string | null }> {
    let q = this.db.kysely
      .selectFrom('core.listing as l')
      .innerJoin('core.property as p', 'p.id', 'l.property_id')
      .select([
        'l.id',
        'l.property_id',
        'l.channel',
        'l.state',
        'l.price',
        'l.currency',
        'p.kind',
        'p.bedrooms',
        'p.floor_area_sqm',
        'p.occupancy',
        'p.address_normalised',
        sql<string | null>`ST_Y(p.geo_point::geometry)::text`.as('lat'),
        sql<string | null>`ST_X(p.geo_point::geometry)::text`.as('lng'),
      ])
      .where('l.state', '=', 'live')
      .orderBy('l.id')
      .limit(params.limit + 1);

    if (params.channel) q = q.where('l.channel', '=', params.channel);
    if (params.price_min) q = q.where('l.price', '>=', params.price_min);
    if (params.price_max) q = q.where('l.price', '<=', params.price_max);
    if (params.bedrooms_min !== undefined)
      q = q.where('p.bedrooms', '>=', params.bedrooms_min);
    if (params.property_kind) q = q.where('p.kind', '=', params.property_kind);
    if (params.occupancy) q = q.where('p.occupancy', '=', params.occupancy);
    if (params.postcodes?.length)
      q = q.where(
        sql<string>`p.address_normalised->>'postcode'`,
        'in',
        params.postcodes,
      );
    if (
      params.lat !== undefined &&
      params.lng !== undefined &&
      params.radius_km !== undefined
    ) {
      q = q.where(
        sql<boolean>`ST_DWithin(p.geo_point, ST_SetSRID(ST_MakePoint(${params.lng}, ${params.lat}), 4326)::geography, ${params.radius_km * 1000})`,
      );
    }
    if (params.cursor) q = q.where('l.id', '>', params.cursor);

    const rows = await q.execute();
    const page = rows.slice(0, params.limit);
    return {
      items: page.map((r) => this.toSummary(r)),
      next_cursor: rows.length > params.limit ? page[page.length - 1].id : null,
    };
  }

  async getListing(listingId: string): Promise<Record<string, unknown>> {
    const row = await this.db.kysely
      .selectFrom('core.listing as l')
      .innerJoin('core.property as p', 'p.id', 'l.property_id')
      .select([
        'l.id',
        'l.property_id',
        'l.channel',
        'l.state',
        'l.price',
        'l.currency',
        'l.description',
        'p.kind',
        'p.bedrooms',
        'p.floor_area_sqm',
        'p.occupancy',
        'p.epc_rating',
        'p.features',
        'p.address_normalised',
        sql<string | null>`ST_Y(p.geo_point::geometry)::text`.as('lat'),
        sql<string | null>`ST_X(p.geo_point::geometry)::text`.as('lng'),
      ])
      .where('l.id', '=', listingId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException({ code: 'listing_not_found' });

    const media = await this.db.kysely
      .selectFrom('core.media_asset')
      .select(['url', 'caption', 'position'])
      .where('property_id', '=', row.property_id)
      .orderBy('position')
      .execute();

    return {
      ...this.toSummary(row),
      description: row.description,
      features: row.features,
      epc_rating: row.epc_rating,
      media: media.map((m) => ({
        url: m.url,
        caption: m.caption,
        position: m.position,
      })),
      deep_link: `${this.deepLinkBase}/${row.id}`,
    };
  }

  private toSummary(r: {
    id: string;
    property_id: string;
    channel: string;
    state: string;
    price: string | null;
    currency: string;
    kind: string | null;
    bedrooms: number | null;
    floor_area_sqm: string | null;
    occupancy: string | null;
    address_normalised: unknown;
    lat: string | null;
    lng: string | null;
  }): Record<string, unknown> {
    const address = r.address_normalised as { city?: string; postcode?: string };
    return {
      id: r.id,
      property_id: r.property_id,
      channel: r.channel,
      state: r.state,
      price: r.price !== null ? { amount: String(r.price), currency: r.currency } : null,
      headline: [r.bedrooms ? `${r.bedrooms}-bed` : null, r.kind ?? 'property', address.city]
        .filter(Boolean)
        .join(' · '),
      city: address.city ?? null,
      postcode: address.postcode ?? null,
      bedrooms: r.bedrooms,
      floor_area_sqm: r.floor_area_sqm !== null ? Number(r.floor_area_sqm) : null,
      property_kind: r.kind ?? 'other',
      occupancy: r.occupancy,
      estimated_rental_yield_percent: null, // estimator ships with portfolio (#29)
      thumbnail_url: null,
      location:
        r.lat !== null && r.lng !== null
          ? { lat: Number(r.lat), lng: Number(r.lng) }
          : null,
    };
  }
}
