import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Db } from '../../shared/database/db.service';

export type SuppressionKind = 'email' | 'phone' | 'address_key' | 'idp_subject';

/**
 * Suppression list over keyed HMACs (domain model §4): the list can block
 * re-ingest of erased subjects without retaining their PII. The key comes
 * from config (KMS-held in production).
 */
@Injectable()
export class SuppressionService {
  private readonly key: string;

  constructor(
    private readonly db: Db,
    config: ConfigService,
  ) {
    this.key = config.getOrThrow<string>('SUPPRESSION_HMAC_KEY');
  }

  hmac(kind: SuppressionKind, normalisedValue: string): string {
    return createHmac('sha256', this.key)
      .update(`${kind}:${normalisedValue}`)
      .digest('hex');
  }

  /** True if ANY of the given identifiers is suppressed. */
  async anySuppressed(
    pairs: { kind: SuppressionKind; value: string }[],
  ): Promise<boolean> {
    if (pairs.length === 0) return false;
    const hmacs = pairs.map((p) => this.hmac(p.kind, p.value));
    const hit = await this.db.kysely
      .selectFrom('core.suppression_entry')
      .select('id')
      .where('value_hmac', 'in', hmacs)
      .limit(1)
      .executeTakeFirst();
    return hit !== undefined;
  }

  /** Idempotent add — used by the erasure pipeline (privacy module). */
  async suppress(
    pairs: { kind: SuppressionKind; value: string }[],
    reason: 'erasure' | 'objection',
    dsrId?: string,
  ): Promise<void> {
    for (const p of pairs) {
      await this.db.kysely
        .insertInto('core.suppression_entry')
        .values({
          kind: p.kind,
          value_hmac: this.hmac(p.kind, p.value),
          reason,
          dsr_id: dsrId ?? null,
        })
        .onConflict((oc) => oc.column('value_hmac').doNothing())
        .execute();
    }
  }
}
