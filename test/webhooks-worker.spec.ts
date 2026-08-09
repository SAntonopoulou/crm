import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { Db } from '../src/shared/database/db.service';
import { SystemClock, TestClock } from '../src/shared/jobs/clock';
import {
  BullJobScheduler,
  InlineJobScheduler,
  JobRegistry,
} from '../src/shared/jobs/job-scheduler';
import { OutboxRelay } from '../src/shared/outbox/outbox-relay';
import {
  WebhookPublisher,
  JOB_WEBHOOK_RETRY,
} from '../src/modules/webhooks/webhook.publisher';
import { JobsRuntime } from '../src/modules/worker/worker.module';
import { Queue } from 'bullmq';

const uuid = () => crypto.randomUUID();

interface Received {
  body: string;
  signature: string;
}

function testServer(behaviour: { failFirst?: number }): Promise<{
  server: Server;
  url: string;
  received: Received[];
}> {
  const received: Received[] = [];
  let failures = behaviour.failFirst ?? 0;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        if (failures > 0) {
          failures--;
          res.writeHead(500).end();
          return;
        }
        received.push({
          body,
          signature: String(req.headers['x-crm-signature'] ?? ''),
        });
        res.writeHead(200).end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
        received,
      });
    });
  });
}

describe('webhooks & worker runtime (#32, #33)', () => {
  let db: Db;

  beforeAll(() => {
    db = new Db(new ConfigService());
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  async function subscribe(url: string, eventTypes: string[], secret: string) {
    return (
      await db.kysely
        .insertInto('core.webhook_subscription')
        .values({ consumer: `test-${uuid()}`, url, event_types: eventTypes, secret })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  }

  it('fan-out: filtered, HMAC-signed, and consumer failures retry without blocking the batch', async () => {
    const clock = new TestClock(new Date('2026-08-14T10:00:00Z'));
    const registry = new JobRegistry();
    const scheduler = new InlineJobScheduler(clock, registry);
    const publisher = new WebhookPublisher(db, clock, scheduler);
    registry.register(JOB_WEBHOOK_RETRY, (p) =>
      publisher.retry((p as { deliveryId: string }).deliveryId),
    );
    const relay = new OutboxRelay(db, publisher);

    const secret = `s-${uuid()}`;
    const listingHook = await testServer({});
    const flakyHook = await testServer({ failFirst: 1 });
    await subscribe(listingHook.url, ['webhooktest.*'], secret);
    const flakySubId = await subscribe(flakyHook.url, ['webhooktest.created'], secret);

    const aggregateId = uuid();
    // Emit two events: one matching both subscriptions, one matching only the wildcard.
    await db.tx(async (ctx) => {
      await ctx.emit({
        aggregateType: 'webhooktest',
        aggregateId,
        eventType: 'webhooktest.created',
        payload: { n: 1 },
      });
      await ctx.emit({
        aggregateType: 'webhooktest',
        aggregateId,
        eventType: 'webhooktest.updated',
        payload: { n: 2 },
      });
    });

    await relay.drain(100);

    // Wildcard subscription got both events, signatures verify.
    const mine = listingHook.received.filter((r) => r.body.includes(aggregateId));
    expect(mine.map((r) => JSON.parse(r.body).type).sort()).toEqual([
      'webhooktest.created',
      'webhooktest.updated',
    ]);
    for (const r of mine) {
      expect(r.signature).toBe(
        createHmac('sha256', secret).update(r.body).digest('hex'),
      );
    }

    // Flaky consumer: first attempt 500s → failed row + retry job; the batch
    // still completed (events are published — the relay was not blocked).
    const failed = await db.kysely
      .selectFrom('core.webhook_delivery')
      .selectAll()
      .where('subscription_id', '=', flakySubId)
      .executeTakeFirstOrThrow();
    expect(failed.state).toBe('failed');
    expect(failed.attempts).toBe(1);

    clock.advance(2 * 60_000); // past the first backoff (60 s)
    await scheduler.drainDue();

    const retried = await db.kysely
      .selectFrom('core.webhook_delivery')
      .selectAll()
      .where('subscription_id', '=', flakySubId)
      .executeTakeFirstOrThrow();
    expect(retried.state).toBe('delivered');
    expect(retried.attempts).toBe(2);
    expect(
      flakyHook.received.filter((r) => r.body.includes(aggregateId)),
    ).toHaveLength(1);

    listingHook.server.close();
    flakyHook.server.close();
  });

  it('worker runtime: a job scheduled on the queue round-trips through Redis to the handler', async () => {
    const queueName = `crm-jobs-test-${uuid()}`;
    const registry = new JobRegistry();
    let resolved: (v: unknown) => void;
    const fired = new Promise((resolve) => (resolved = resolve));
    registry.register('worker.test', async (payload) => resolved(payload));

    const runtime = new JobsRuntime(
      new ConfigService({
        JOBS_ENABLED: 'true',
        REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
        JOBS_QUEUE_NAME: queueName,
      }),
      registry,
    );
    // Repeatable schedules reference handlers we haven't registered in this
    // bare registry — register no-ops so scheduled fires don't error.
    for (const name of [
      'outbox.relay_tick', 'privacy.grant_revoke', 'privacy.retention_sweep',
      'agents.doc_lapse_check', 'portfolio.revalue',
    ]) {
      registry.register(name, async () => {});
    }
    await runtime.onModuleInit();

    const queue = new Queue(queueName, {
      connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
    });
    const scheduler = new BullJobScheduler(queue, new SystemClock());
    await scheduler.schedule('worker.test', { hello: 'redis' }, new Date());

    const payload = await Promise.race([
      fired,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('worker never fired')), 10_000),
      ),
    ]);
    expect(payload).toEqual({ hello: 'redis' });

    await queue.obliterate({ force: true });
    await queue.close();
    await runtime.onModuleDestroy();
  }, 20_000);
});
