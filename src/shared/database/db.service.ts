import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect, Transaction } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './db';

export interface DomainEvent {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  schemaVersion?: number;
}

/**
 * Transaction context handed to every domain write. Emitting an event here
 * writes the outbox row in the SAME transaction as the domain change — the
 * only legal way to publish events.
 */
export class TxContext {
  constructor(readonly trx: Transaction<DB>) {}

  async emit(event: DomainEvent): Promise<void> {
    await this.trx
      .insertInto('core.outbox_event')
      .values({
        aggregate_type: event.aggregateType,
        aggregate_id: event.aggregateId,
        event_type: event.eventType,
        payload: JSON.stringify(event.payload),
        schema_version: event.schemaVersion ?? 1,
      })
      .execute();
  }
}

@Injectable()
export class Db implements OnModuleDestroy {
  readonly kysely: Kysely<DB>;
  readonly pool: Pool;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      max: 10,
    });
    this.kysely = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: this.pool }),
    });
  }

  /** Run a domain write transaction; events emitted via ctx are atomic with it. */
  async tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return this.kysely
      .transaction()
      .execute(async (trx) => fn(new TxContext(trx)));
  }

  async onModuleDestroy(): Promise<void> {
    await this.kysely.destroy();
  }
}
