import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { Db } from '../../shared/database/db.service';

export interface ProfileInput {
  name?: string;
  channel?: 'sale' | 'rent';
  budget_min?: { amount: string; currency: string };
  budget_max?: { amount: string; currency: string };
  areas?: { polygons?: object; postcodes?: string[] };
  bedrooms_min?: number;
  must_haves?: string[];
  deal_breakers?: string[];
  active?: boolean;
}

@Injectable()
export class ProfilesService {
  constructor(private readonly db: Db) {}

  async list(contactId: string): Promise<unknown[]> {
    const rows = await this.db.kysely
      .selectFrom('core.requirement_profile')
      .select([
        'id', 'name', 'channel', 'budget_min', 'budget_max', 'currency',
        'postcodes', 'bedrooms_min', 'must_haves', 'deal_breakers', 'active', 'created_at',
        sql<string | null>`ST_AsGeoJSON(areas)`.as('areas_geojson'),
      ])
      .where('contact_id', '=', contactId)
      .orderBy('created_at')
      .execute();
    return rows.map((r) => this.toView(r));
  }

  async create(contactId: string, input: ProfileInput): Promise<unknown> {
    if (!input.channel) throw new BadRequestException({ code: 'channel_required' });
    const id = await this.db.tx(async (ctx) => {
      const row = await ctx.trx
        .insertInto('core.requirement_profile')
        .values({
          contact_id: contactId,
          name: input.name ?? null,
          channel: input.channel!,
          budget_min: input.budget_min?.amount ?? null,
          budget_max: input.budget_max?.amount ?? null,
          currency: input.budget_max?.currency ?? input.budget_min?.currency ?? 'EUR',
          areas: input.areas?.polygons
            ? sql`ST_GeomFromGeoJSON(${JSON.stringify(input.areas.polygons)})::geography`
            : null,
          postcodes: input.areas?.postcodes ?? null,
          bedrooms_min: input.bedrooms_min ?? null,
          must_haves: JSON.stringify(input.must_haves ?? []),
          deal_breakers: JSON.stringify(input.deal_breakers ?? []),
          active: input.active ?? true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    const all = (await this.list(contactId)) as { id: string }[];
    return all.find((p) => p.id === id);
  }

  async update(
    contactId: string,
    profileId: string,
    input: ProfileInput,
  ): Promise<unknown> {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.budget_min !== undefined) updates.budget_min = input.budget_min?.amount ?? null;
    if (input.budget_max !== undefined) updates.budget_max = input.budget_max?.amount ?? null;
    if (input.bedrooms_min !== undefined) updates.bedrooms_min = input.bedrooms_min;
    if (input.must_haves !== undefined) updates.must_haves = JSON.stringify(input.must_haves);
    if (input.deal_breakers !== undefined)
      updates.deal_breakers = JSON.stringify(input.deal_breakers);
    if (input.active !== undefined) updates.active = input.active;
    if (input.areas !== undefined) {
      updates.areas = input.areas?.polygons
        ? sql`ST_GeomFromGeoJSON(${JSON.stringify(input.areas.polygons)})::geography`
        : null;
      updates.postcodes = input.areas?.postcodes ?? null;
    }

    const row = await this.db.kysely
      .updateTable('core.requirement_profile')
      .set(updates)
      .where('id', '=', profileId)
      .where('contact_id', '=', contactId)
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new NotFoundException({ code: 'profile_not_found' });
    const all = (await this.list(contactId)) as { id: string }[];
    return all.find((p) => p.id === profileId);
  }

  private toView(r: {
    id: string;
    name: string | null;
    channel: string;
    budget_min: string | null;
    budget_max: string | null;
    currency: string;
    postcodes: string[] | null;
    bedrooms_min: number | null;
    must_haves: unknown;
    deal_breakers: unknown;
    active: boolean;
    created_at: Date;
    areas_geojson: string | null;
  }): unknown {
    const money = (amount: string | null) =>
      amount === null ? undefined : { amount: Number(amount).toFixed(2), currency: r.currency };
    return {
      id: r.id,
      name: r.name ?? undefined,
      channel: r.channel,
      budget_min: money(r.budget_min),
      budget_max: money(r.budget_max),
      areas: {
        polygons: r.areas_geojson ? JSON.parse(r.areas_geojson) : undefined,
        postcodes: r.postcodes ?? undefined,
      },
      bedrooms_min: r.bedrooms_min ?? undefined,
      must_haves: r.must_haves,
      deal_breakers: r.deal_breakers,
      active: r.active,
      created_at: r.created_at.toISOString(),
    };
  }
}
