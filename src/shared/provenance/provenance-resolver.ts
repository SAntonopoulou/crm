import { Injectable } from '@nestjs/common';
import { Transaction } from 'kysely';
import type { DB } from '../database/db';

export type ProvenanceMethod = 'scraped' | 'owner_submitted' | 'staff_verified';

const DEFAULT_RANKING: readonly ProvenanceMethod[] = [
  'scraped',
  'owner_submitted',
  'staff_verified',
];

export interface IncomingValue {
  entityType: string;
  entityId: string;
  field: string;
  value: unknown;
  method: ProvenanceMethod;
  confidence?: number;
  sourceId?: string;
  collectedAt: Date;
}

export interface Resolution {
  /** True → caller applies the domain write. False → value parked as candidate. */
  applied: boolean;
}

/**
 * The single write path for provenance-bearing fields. An incoming value is
 * applied only when its method ranks at or above the current value's method
 * (equal rank: latest write wins — a re-scrape refreshes scraped data).
 * A losing value is parked on the provenance row as `candidate` for review —
 * "owner-confirmed supersedes scraped" is structural, not conventional.
 */
@Injectable()
export class ProvenanceResolver {
  async resolve(trx: Transaction<DB>, incoming: IncomingValue): Promise<Resolution> {
    const ranking = await this.ranking(trx, incoming.entityType, incoming.field);
    const rank = (m: string): number => {
      const i = ranking.indexOf(m as ProvenanceMethod);
      return i === -1 ? 0 : i;
    };

    const current = await trx
      .selectFrom('core.field_provenance')
      .selectAll()
      .where('entity_type', '=', incoming.entityType)
      .where('entity_id', '=', incoming.entityId)
      .where('field_name', '=', incoming.field)
      .forUpdate()
      .executeTakeFirst();

    if (!current || rank(incoming.method) >= rank(current.method)) {
      await trx
        .insertInto('core.field_provenance')
        .values({
          entity_type: incoming.entityType,
          entity_id: incoming.entityId,
          field_name: incoming.field,
          source_id: incoming.sourceId ?? null,
          method: incoming.method,
          confidence: incoming.confidence ?? null,
          collected_at: incoming.collectedAt,
          candidate: null,
        })
        .onConflict((oc) =>
          oc.columns(['entity_type', 'entity_id', 'field_name']).doUpdateSet({
            source_id: incoming.sourceId ?? null,
            method: incoming.method,
            confidence: incoming.confidence ?? null,
            collected_at: incoming.collectedAt,
            candidate: null,
            updated_at: new Date(),
          }),
        )
        .execute();
      return { applied: true };
    }

    await trx
      .updateTable('core.field_provenance')
      .set({
        candidate: JSON.stringify({
          value: incoming.value,
          method: incoming.method,
          confidence: incoming.confidence ?? null,
          source_id: incoming.sourceId ?? null,
          collected_at: incoming.collectedAt.toISOString(),
        }),
        updated_at: new Date(),
      })
      .where('entity_type', '=', incoming.entityType)
      .where('entity_id', '=', incoming.entityId)
      .where('field_name', '=', incoming.field)
      .execute();
    return { applied: false };
  }

  private async ranking(
    trx: Transaction<DB>,
    entityType: string,
    field: string,
  ): Promise<readonly ProvenanceMethod[]> {
    const rule = await trx
      .selectFrom('core.field_precedence_rule')
      .select('method_ranking')
      .where('entity_type', '=', entityType)
      .where('field_name', '=', field)
      .executeTakeFirst();
    if (!rule) return DEFAULT_RANKING;
    return rule.method_ranking as ProvenanceMethod[];
  }
}
