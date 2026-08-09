import { Inject, Injectable, Optional } from '@nestjs/common';
import { Db } from '../database/db.service';

export interface PublishableEvent {
  seq: string;
  id: string;
  type: string;
  occurredAt: Date;
  aggregate: { type: string; id: string };
  schemaVersion: number;
  payload: unknown;
}

/**
 * Delivery target for the relay (webhook fan-out, log, test spy).
 * Throwing fails the whole batch: rows stay unpublished and are retried —
 * consumers must deduplicate on `id` (at-least-once is the contract).
 */
export interface EventPublisher {
  publish(events: PublishableEvent[]): Promise<void>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

/** Default publisher until webhook subscriptions ship (migration group 100). */
export class NoopPublisher implements EventPublisher {
  async publish(): Promise<void> {
    // Events accumulate unpublished until a real publisher is bound; that is
    // deliberate — nothing is lost, and the relay drains the backlog later.
    throw new Error('no publisher bound');
  }
}

@Injectable()
export class OutboxRelay {
  constructor(
    private readonly db: Db,
    @Optional() @Inject(EVENT_PUBLISHER) private publisher?: EventPublisher,
  ) {}

  bind(publisher: EventPublisher): void {
    this.publisher = publisher;
  }

  /**
   * Drain one batch. Rows are locked (SKIP LOCKED, so concurrent relays never
   * double-deliver), published, then marked — all in one transaction. A crash
   * after publish but before commit re-delivers the batch: at-least-once.
   */
  async runOnce(batchSize = 100): Promise<number> {
    const publisher = this.publisher;
    if (!publisher) return 0;
    return this.db.kysely.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('core.outbox_event')
        .selectAll()
        .where('published_at', 'is', null)
        .orderBy('seq')
        .limit(batchSize)
        .forUpdate()
        .skipLocked()
        .execute();
      if (rows.length === 0) return 0;

      await publisher.publish(
        rows.map((r) => ({
          seq: String(r.seq),
          id: r.id,
          type: r.event_type,
          occurredAt: r.occurred_at,
          aggregate: { type: r.aggregate_type, id: r.aggregate_id },
          schemaVersion: r.schema_version,
          payload: r.payload,
        })),
      );

      await trx
        .updateTable('core.outbox_event')
        .set({ published_at: new Date() })
        .where(
          'seq',
          'in',
          rows.map((r) => r.seq),
        )
        .execute();
      return rows.length;
    });
  }

  /** Drain until empty (used by tests and the scheduled job). */
  async drain(batchSize = 100): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.runOnce(batchSize);
      total += n;
      if (n === 0) return total;
    }
  }
}
