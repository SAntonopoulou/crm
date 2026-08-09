import { Injectable } from '@nestjs/common';
import { Transaction } from 'kysely';
import { Db } from '../database/db.service';
import type { DB } from '../database/db';

export type PiiAction = 'read' | 'reveal' | 'write' | 'export';

export interface PiiAccessEntry {
  actorId: string;
  subjectContactId?: string;
  /** e.g. "contact_channel.value", "contact_sensitive.iban" */
  entityField: string;
  action: PiiAction;
  /** Required for 'reveal' — enforced here, not left to callers. */
  reason?: string;
  context?: Record<string, unknown>;
}

export class ReasonRequiredError extends Error {
  constructor() {
    super('a reason is required to reveal masked PII');
  }
}

/**
 * Append-only writer to audit.pii_access_log. Append-only is enforced by
 * Postgres grants (crm_app has INSERT+SELECT only), not by this class.
 * Writes are logged in the caller's transaction so a rolled-back write leaves
 * no phantom audit row; reads are logged outside any transaction.
 */
@Injectable()
export class AuditLog {
  constructor(private readonly db: Db) {}

  async record(entry: PiiAccessEntry, trx?: Transaction<DB>): Promise<void> {
    if (entry.action === 'reveal' && !entry.reason?.trim()) {
      throw new ReasonRequiredError();
    }
    await (trx ?? this.db.kysely)
      .insertInto('audit.pii_access_log')
      .values({
        actor_id: entry.actorId,
        subject_contact_id: entry.subjectContactId ?? null,
        entity_field: entry.entityField,
        action: entry.action,
        reason: entry.reason ?? null,
        request_context: JSON.stringify(entry.context ?? {}),
      })
      .execute();
  }

  async recordAll(
    entries: PiiAccessEntry[],
    trx?: Transaction<DB>,
  ): Promise<void> {
    for (const entry of entries) await this.record(entry, trx);
  }
}
