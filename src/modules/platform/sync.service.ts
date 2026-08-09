import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Db } from '../../shared/database/db.service';

interface SyncChange {
  type: string;
  id: string;
  sync_seq: number;
  data: Record<string, unknown>;
}

interface SyncTombstone {
  type: string;
  id: string;
  sync_seq: number;
}

const ALL_TYPES = ['listing', 'appointment', 'offer', 'portfolio_entry', 'contact'] as const;
type SyncType = (typeof ALL_TYPES)[number];
const TOMBSTONE_TYPES = ['contact', 'portfolio_entry'];

/**
 * Contract: GET /v1/sync — changes + tombstones ordered by the global
 * sync_seq, role-filtered server-side. Cursor = the last seq the client
 * has seen; deterministic and clock-skew-free by construction.
 */
@Injectable()
export class SyncService {
  constructor(private readonly db: Db) {}

  async sync(
    contactId: string,
    since: number,
    types: SyncType[] | undefined,
    limit: number,
  ): Promise<{
    changes: SyncChange[];
    tombstones: SyncTombstone[];
    next_since: number;
    has_more: boolean;
  }> {
    const wanted = new Set(types?.length ? types : ALL_TYPES);
    const fetch = limit + 1;
    const batches: SyncChange[][] = [];

    if (wanted.has('listing')) batches.push(await this.listings(since, fetch));
    if (wanted.has('appointment')) batches.push(await this.appointments(contactId, since, fetch));
    if (wanted.has('offer')) batches.push(await this.offers(contactId, since, fetch));
    if (wanted.has('portfolio_entry')) batches.push(await this.portfolio(contactId, since, fetch));
    if (wanted.has('contact')) batches.push(await this.self(contactId, since));

    const tombstoneRows = await this.db.kysely
      .selectFrom('core.tombstone')
      .select(['entity_type', 'entity_id', 'sync_seq'])
      .where('entity_type', 'in', TOMBSTONE_TYPES.filter((t) => wanted.has(t as SyncType)))
      .where('sync_seq', '>', String(since))
      .orderBy('sync_seq')
      .limit(fetch)
      .execute()
      .catch(() => []);

    const merged = [
      ...batches.flat().map((c) => ({ kind: 'change' as const, seq: c.sync_seq, change: c })),
      ...tombstoneRows.map((t) => ({
        kind: 'tombstone' as const,
        seq: Number(t.sync_seq),
        tombstone: { type: t.entity_type, id: t.entity_id, sync_seq: Number(t.sync_seq) },
      })),
    ].sort((a, b) => a.seq - b.seq);

    const has_more = merged.length > limit;
    const page = merged.slice(0, limit);
    const next_since = page.length > 0 ? page[page.length - 1].seq : since;

    return {
      changes: page.filter((e) => e.kind === 'change').map((e) => e.change!),
      tombstones: page.filter((e) => e.kind === 'tombstone').map((e) => e.tombstone!),
      next_since,
      has_more,
    };
  }

  private async listings(since: number, limit: number): Promise<SyncChange[]> {
    const rows = await this.db.kysely
      .selectFrom('core.listing as l')
      .innerJoin('core.property as p', 'p.id', 'l.property_id')
      .select([
        'l.id', 'l.sync_seq', 'l.property_id', 'l.channel', 'l.state', 'l.price', 'l.currency',
        'p.kind', 'p.bedrooms', 'p.floor_area_sqm', 'p.occupancy',
        sql<string | null>`p.address_normalised->>'city'`.as('city'),
        sql<string | null>`p.address_normalised->>'postcode'`.as('postcode'),
      ])
      .where('l.sync_seq', '>', String(since))
      .where('l.state', '=', 'live')
      .orderBy('l.sync_seq')
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      type: 'listing',
      id: r.id,
      sync_seq: Number(r.sync_seq),
      data: {
        id: r.id,
        property_id: r.property_id,
        channel: r.channel,
        state: r.state,
        price: r.price !== null ? { amount: String(r.price), currency: r.currency } : null,
        city: r.city,
        postcode: r.postcode,
        bedrooms: r.bedrooms,
        floor_area_sqm: r.floor_area_sqm !== null ? Number(r.floor_area_sqm) : null,
        property_kind: r.kind ?? 'other',
        occupancy: r.occupancy,
      },
    }));
  }

  private async appointments(contactId: string, since: number, limit: number): Promise<SyncChange[]> {
    const rows = await this.db.kysely
      .selectFrom('core.appointment')
      .select([
        'id', 'sync_seq', 'listing_id', 'state', 'kind', 'viewer_contact_id', 'agent_id',
        sql<Date>`lower(during)`.as('starts_at'),
        sql<Date>`upper(during)`.as('ends_at'),
      ])
      .where((eb) =>
        eb.or([eb('viewer_contact_id', '=', contactId), eb('agent_id', '=', contactId)]),
      )
      .where('sync_seq', '>', String(since))
      .orderBy('sync_seq')
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      type: 'appointment',
      id: r.id,
      sync_seq: Number(r.sync_seq),
      data: {
        id: r.id,
        listing_id: r.listing_id,
        state: r.state,
        kind: r.kind,
        starts_at: r.starts_at.toISOString(),
        ends_at: r.ends_at.toISOString(),
        viewer: { contact_id: r.viewer_contact_id },
        ...(r.agent_id ? { agent: { contact_id: r.agent_id } } : {}),
      },
    }));
  }

  private async offers(contactId: string, since: number, limit: number): Promise<SyncChange[]> {
    const rows = await this.db.kysely
      .selectFrom('core.dispatch_offer as o')
      .innerJoin('core.dispatch as d', 'd.id', 'o.dispatch_id')
      .innerJoin('core.appointment as a', 'a.id', 'd.appointment_id')
      .select([
        'o.id', 'o.sync_seq', 'o.state', 'o.ttl_expires_at',
        sql<Date>`lower(a.during)`.as('starts_at'),
        sql<Date>`upper(a.during)`.as('ends_at'),
      ])
      .where('o.agent_id', '=', contactId)
      .where('o.sync_seq', '>', String(since))
      .orderBy('o.sync_seq')
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      type: 'offer',
      id: r.id,
      sync_seq: Number(r.sync_seq),
      data: {
        id: r.id,
        state: r.state,
        ttl_expires_at: r.ttl_expires_at.toISOString(),
        appointment_summary: {
          starts_at: r.starts_at.toISOString(),
          ends_at: r.ends_at.toISOString(),
        },
      },
    }));
  }

  private async portfolio(contactId: string, since: number, limit: number): Promise<SyncChange[]> {
    const rows = await this.db.kysely
      .selectFrom('core.portfolio_entry')
      .selectAll()
      .where('contact_id', '=', contactId)
      .where('sync_seq', '>', String(since))
      .orderBy('sync_seq')
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      type: 'portfolio_entry',
      id: r.id,
      sync_seq: Number(r.sync_seq),
      data: {
        property_id: r.property_id,
        purchase_price: { amount: Number(r.purchase_price).toFixed(2), currency: r.currency },
        monthly_rental_income: { amount: Number(r.monthly_rental_income).toFixed(2), currency: r.currency },
        monthly_expenses: { amount: Number(r.monthly_expenses).toFixed(2), currency: r.currency },
        ...(r.outstanding_debt !== null
          ? { outstanding_debt: { amount: Number(r.outstanding_debt).toFixed(2), currency: r.currency } }
          : {}),
        ...(r.monthly_mortgage_payment !== null
          ? { monthly_mortgage_payment: { amount: Number(r.monthly_mortgage_payment).toFixed(2), currency: r.currency } }
          : {}),
        status: r.status,
        added_at: r.added_at.toISOString(),
        // current_value_estimate deliberately omitted from sync payloads:
        // it's derived; clients fetch it via GET /me/portfolio.
      },
    }));
  }

  private async self(contactId: string, since: number): Promise<SyncChange[]> {
    const row = await this.db.kysely
      .selectFrom('core.contact')
      .select(['id', 'sync_seq', 'lifecycle_state', 'display_name', 'locale', 'timezone'])
      .where('id', '=', contactId)
      .where('sync_seq', '>', String(since))
      .where('lifecycle_state', '<>', 'erased')
      .executeTakeFirst();
    if (!row) return [];
    return [
      {
        type: 'contact',
        id: row.id,
        sync_seq: Number(row.sync_seq),
        data: {
          id: row.id,
          lifecycle_state: row.lifecycle_state,
          display_name: row.display_name,
          locale: row.locale,
          timezone: row.timezone,
        },
      },
    ];
  }
}
