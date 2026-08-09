import { createHmac } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Db } from '../../shared/database/db.service';
import { Clock } from '../../shared/jobs/clock';
import { JobScheduler } from '../../shared/jobs/job-scheduler';
import {
  EventPublisher,
  PublishableEvent,
} from '../../shared/outbox/outbox-relay';

export const JOB_WEBHOOK_RETRY = 'webhooks.retry';
export const JOB_RELAY_TICK = 'outbox.relay_tick';

const MAX_ATTEMPTS = 10;
const TIMEOUT_MS = 5_000;

/**
 * Fans outbox events out to subscribed consumers. A failing consumer NEVER
 * blocks the relay batch: failures become per-delivery retry jobs with
 * exponential backoff; after MAX_ATTEMPTS the delivery goes dead (ops board).
 * Deliveries are HMAC-SHA256 signed; consumers dedupe on event id.
 */
@Injectable()
export class WebhookPublisher implements EventPublisher {
  private readonly logger = new Logger(WebhookPublisher.name);

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    @Optional() private readonly jobs?: JobScheduler,
  ) {}

  async publish(events: PublishableEvent[]): Promise<void> {
    const subscriptions = await this.db.kysely
      .selectFrom('core.webhook_subscription')
      .selectAll()
      .where('enabled', '=', true)
      .execute();
    if (subscriptions.length === 0) return;

    for (const event of events) {
      for (const subscription of subscriptions) {
        if (!matches(subscription.event_types, event.type)) continue;
        const delivery = await this.db.kysely
          .insertInto('core.webhook_delivery')
          .values({
            subscription_id: subscription.id,
            event_seq: event.seq,
            event_id: event.id,
          })
          .onConflict((oc) => oc.columns(['subscription_id', 'event_id']).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!delivery) continue; // relay redelivery; already tracked
        await this.attempt(delivery.id, subscription, event);
      }
    }
  }

  /** Job handler: retry a failed delivery with the event rebuilt from the outbox. */
  async retry(deliveryId: string): Promise<void> {
    const delivery = await this.db.kysely
      .selectFrom('core.webhook_delivery as d')
      .innerJoin('core.webhook_subscription as s', 's.id', 'd.subscription_id')
      .select(['d.id', 'd.event_id', 'd.state', 'd.attempts', 's.id as sub_id', 's.url', 's.secret', 's.event_types', 's.enabled'])
      .where('d.id', '=', deliveryId)
      .executeTakeFirst();
    if (!delivery || delivery.state === 'delivered' || delivery.state === 'dead') return;
    if (!delivery.enabled) return;

    const event = await this.db.kysely
      .selectFrom('core.outbox_event')
      .selectAll()
      .where('id', '=', delivery.event_id)
      .executeTakeFirst();
    if (!event) return;

    await this.attempt(
      delivery.id,
      { id: delivery.sub_id, url: delivery.url, secret: delivery.secret },
      {
        seq: String(event.seq),
        id: event.id,
        type: event.event_type,
        occurredAt: event.occurred_at,
        aggregate: { type: event.aggregate_type, id: event.aggregate_id },
        schemaVersion: event.schema_version,
        payload: event.payload,
      },
      delivery.attempts,
    );
  }

  private async attempt(
    deliveryId: string,
    subscription: { id: string; url: string; secret: string },
    event: PublishableEvent,
    priorAttempts = 0,
  ): Promise<void> {
    const body = JSON.stringify({
      seq: Number(event.seq),
      id: event.id,
      type: event.type,
      occurred_at: event.occurredAt.toISOString(),
      aggregate: event.aggregate,
      schema_version: event.schemaVersion,
      payload: event.payload,
    });
    const signature = createHmac('sha256', subscription.secret)
      .update(body)
      .digest('hex');

    let error: string | null = null;
    try {
      const response = await fetch(subscription.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-crm-signature': signature,
          'x-crm-event-seq': String(event.seq),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) error = `http_${response.status}`;
    } catch (err) {
      error = String(err).slice(0, 500);
    }

    if (error === null) {
      await this.db.kysely
        .updateTable('core.webhook_delivery')
        .set({
          state: 'delivered',
          attempts: priorAttempts + 1,
          delivered_at: this.clock.now(),
          last_error: null,
        })
        .where('id', '=', deliveryId)
        .execute();
      return;
    }

    const attempts = priorAttempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    await this.db.kysely
      .updateTable('core.webhook_delivery')
      .set({ state: dead ? 'dead' : 'failed', attempts, last_error: error })
      .where('id', '=', deliveryId)
      .execute();
    if (dead) {
      this.logger.error(`webhook delivery ${deliveryId} dead after ${attempts} attempts: ${error}`);
      return;
    }
    const backoffMs = Math.min(2 ** attempts * 30_000, 3_600_000);
    await this.jobs?.schedule(
      JOB_WEBHOOK_RETRY,
      { deliveryId },
      new Date(this.clock.now().getTime() + backoffMs),
      { dedupeId: `wh:${deliveryId}` },
    );
  }
}

function matches(eventTypes: string[], type: string): boolean {
  if (eventTypes.length === 0) return true; // empty filter = firehose
  return eventTypes.some((pattern) =>
    pattern.endsWith('.*')
      ? type.startsWith(pattern.slice(0, -1))
      : pattern === type,
  );
}
