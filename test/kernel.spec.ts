import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Db } from '../src/shared/database/db.service';
import {
  OutboxRelay,
  PublishableEvent,
  EventPublisher,
} from '../src/shared/outbox/outbox-relay';
import { AuditLog, ReasonRequiredError } from '../src/shared/audit/audit-log.service';
import {
  ProvenanceResolver,
  ProvenanceMethod,
} from '../src/shared/provenance/provenance-resolver';
import { TestClock } from '../src/shared/jobs/clock';
import { InlineJobScheduler, JobRegistry } from '../src/shared/jobs/job-scheduler';

const uuid = () => crypto.randomUUID();

describe('kernel', () => {
  let db: Db;

  beforeAll(() => {
    db = new Db(new ConfigService());
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  describe('tx + outbox writer (#10)', () => {
    it('event emission is atomic with the domain transaction', async () => {
      const aggregateId = uuid();
      await expect(
        db.tx(async (ctx) => {
          await ctx.emit({
            aggregateType: 'smoke',
            aggregateId,
            eventType: 'smoke.exploded',
            payload: { boom: true },
          });
          throw new Error('domain write failed');
        }),
      ).rejects.toThrow('domain write failed');

      const rows = await db.kysely
        .selectFrom('core.outbox_event')
        .selectAll()
        .where('aggregate_id', '=', aggregateId)
        .execute();
      expect(rows).toHaveLength(0);
    });

    it('committed transactions persist their events', async () => {
      const aggregateId = uuid();
      await db.tx(async (ctx) => {
        await ctx.emit({
          aggregateType: 'smoke',
          aggregateId,
          eventType: 'smoke.ok',
          payload: { n: 1 },
        });
      });
      const rows = await db.kysely
        .selectFrom('core.outbox_event')
        .selectAll()
        .where('aggregate_id', '=', aggregateId)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].published_at).toBeNull();
    });
  });

  describe('outbox relay (#11)', () => {
    class SpyPublisher implements EventPublisher {
      delivered: PublishableEvent[] = [];
      failAfter = Infinity;
      async publish(events: PublishableEvent[]): Promise<void> {
        this.delivered.push(...events);
        if (this.delivered.length >= this.failAfter) {
          throw new Error('publisher crashed');
        }
      }
    }

    async function emitEvents(n: number, type: string): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const aggregateId = uuid();
        ids.push(aggregateId);
        await db.tx((ctx) =>
          ctx.emit({
            aggregateType: 'relaytest',
            aggregateId,
            eventType: type,
            payload: { i },
          }),
        );
      }
      return ids;
    }

    it('crash mid-batch loses nothing; restart redelivers; dedup by id is exact', async () => {
      // Drain anything left over from other tests first.
      const cleanup = new SpyPublisher();
      const preRelay = new OutboxRelay(db, cleanup);
      await preRelay.drain();

      await emitEvents(5, 'relay.crashcase');
      const crashy = new SpyPublisher();
      crashy.failAfter = 2; // dies inside the first batch
      const relay = new OutboxRelay(db, crashy);

      await expect(relay.runOnce(2)).rejects.toThrow('publisher crashed');
      const unpublished = await db.kysely
        .selectFrom('core.outbox_event')
        .select(db.kysely.fn.countAll().as('n'))
        .where('published_at', 'is', null)
        .where('event_type', '=', 'relay.crashcase')
        .executeTakeFirstOrThrow();
      expect(Number(unpublished.n)).toBe(5); // batch rolled back, nothing marked

      crashy.failAfter = Infinity; // "restart"
      const total = await relay.drain(2);
      expect(total).toBeGreaterThanOrEqual(5); // ≥: other suites may have queued events

      // At-least-once: 2 duplicates from the crashed batch are legal;
      // consumer-side dedup by id must land on exactly the 5 events.
      const uniqueIds = new Set(
        crashy.delivered
          .filter((e) => e.type === 'relay.crashcase')
          .map((e) => e.id),
      );
      expect(uniqueIds.size).toBe(5);

      const stillUnpublished = await db.kysely
        .selectFrom('core.outbox_event')
        .select(db.kysely.fn.countAll().as('n'))
        .where('published_at', 'is', null)
        .where('event_type', 'like', 'relay.%')
        .executeTakeFirstOrThrow();
      expect(Number(stillUnpublished.n)).toBe(0);
    });

    it('delivers in seq order within a drain', async () => {
      await emitEvents(3, 'relay.order');
      const spy = new SpyPublisher();
      const relay = new OutboxRelay(db, spy);
      await relay.drain(2);
      const seqs = spy.delivered
        .filter((e) => e.type === 'relay.order')
        .map((e) => Number(e.seq));
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    });
  });

  describe('audit log (#12)', () => {
    it('records reads and enforces reason-for-reveal', async () => {
      const audit = new AuditLog(db);
      const actorId = uuid();
      await audit.record({
        actorId,
        subjectContactId: uuid(),
        entityField: 'contact_channel.value',
        action: 'read',
        context: { route: '/v1/test' },
      });
      const rows = await db.kysely
        .selectFrom('audit.pii_access_log')
        .selectAll()
        .where('actor_id', '=', actorId)
        .execute();
      expect(rows).toHaveLength(1);

      await expect(
        audit.record({
          actorId,
          entityField: 'contact_sensitive.iban',
          action: 'reveal',
        }),
      ).rejects.toThrow(ReasonRequiredError);
    });

    it('crm_app role physically cannot UPDATE or DELETE audit rows', async () => {
      const client = await db.pool.connect();
      try {
        await client.query('SET ROLE crm_app');
        await expect(
          client.query(`UPDATE audit.pii_access_log SET reason = 'tampered'`),
        ).rejects.toThrow(/permission denied/);
        await expect(
          client.query(`DELETE FROM audit.pii_access_log`),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
    });
  });

  describe('provenance resolver (#13)', () => {
    const resolver = new ProvenanceResolver();

    async function write(
      entityId: string,
      method: ProvenanceMethod,
      value: string,
      collectedAt = new Date(),
    ) {
      return db.tx((ctx) =>
        resolver.resolve(ctx.trx, {
          entityType: 'listing',
          entityId,
          field: 'price',
          value,
          method,
          collectedAt,
          confidence: 0.9,
        }),
      );
    }

    it('owner-submitted beats scraped; the losing re-scrape parks as candidate', async () => {
      const entityId = uuid();
      expect((await write(entityId, 'scraped', '300000')).applied).toBe(true);
      expect((await write(entityId, 'owner_submitted', '290000')).applied).toBe(true);
      expect((await write(entityId, 'scraped', '310000')).applied).toBe(false);

      const row = await db.kysely
        .selectFrom('core.field_provenance')
        .selectAll()
        .where('entity_id', '=', entityId)
        .executeTakeFirstOrThrow();
      expect(row.method).toBe('owner_submitted');
      expect((row.candidate as { value: string }).value).toBe('310000');

      expect((await write(entityId, 'staff_verified', '295000')).applied).toBe(true);
      const after = await db.kysely
        .selectFrom('core.field_provenance')
        .selectAll()
        .where('entity_id', '=', entityId)
        .executeTakeFirstOrThrow();
      expect(after.method).toBe('staff_verified');
      expect(after.candidate).toBeNull(); // applying clears the parked candidate
    });

    it('equal rank: the latest write wins (re-scrapes refresh scraped data)', async () => {
      const entityId = uuid();
      expect((await write(entityId, 'scraped', '100')).applied).toBe(true);
      expect((await write(entityId, 'scraped', '110')).applied).toBe(true);
    });

    it('randomized sequences always end on the highest-precedence writer', async () => {
      // Deterministic LCG so failures reproduce.
      let seed = 42;
      const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      const methods: ProvenanceMethod[] = ['scraped', 'owner_submitted', 'staff_verified'];
      const rank = (m: ProvenanceMethod) => methods.indexOf(m);

      for (let round = 0; round < 10; round++) {
        const entityId = uuid();
        const seq: ProvenanceMethod[] = Array.from(
          { length: 8 },
          () => methods[Math.floor(rand() * 3)],
        );
        for (const m of seq) await write(entityId, m, `v-${m}-${rand()}`);

        const row = await db.kysely
          .selectFrom('core.field_provenance')
          .selectAll()
          .where('entity_id', '=', entityId)
          .executeTakeFirstOrThrow();
        const maxRank = Math.max(...seq.map(rank));
        expect(rank(row.method as ProvenanceMethod)).toBe(maxRank);
      }
    });
  });

  describe('clock + inline scheduler (#14)', () => {
    it('jobs fire under time control, exactly once, and cancel works', async () => {
      const clock = new TestClock(new Date('2026-08-09T10:00:00Z'));
      const registry = new JobRegistry();
      const fired: string[] = [];
      registry.register('ttl.expire', async (p) =>
        void fired.push((p as { id: string }).id),
      );

      const scheduler = new InlineJobScheduler(clock, registry);
      await scheduler.schedule('ttl.expire', { id: 'a' }, new Date('2026-08-09T10:02:00Z'), {
        dedupeId: 'offer:a',
      });
      await scheduler.schedule('ttl.expire', { id: 'b' }, new Date('2026-08-09T10:05:00Z'), {
        dedupeId: 'offer:b',
      });

      expect(await scheduler.drainDue()).toBe(0); // nothing due yet

      clock.advance(3 * 60 * 1000);
      expect(await scheduler.drainDue()).toBe(1);
      expect(fired).toEqual(['a']);
      expect(await scheduler.drainDue()).toBe(0); // idempotent re-drain

      await scheduler.cancel('offer:b');
      clock.advance(10 * 60 * 1000);
      expect(await scheduler.drainDue()).toBe(0); // cancelled TTL never fires
      expect(scheduler.pendingCount()).toBe(0);
    });

    it('rescheduling with the same dedupeId replaces the timer', async () => {
      const clock = new TestClock(new Date('2026-08-09T10:00:00Z'));
      const registry = new JobRegistry();
      let count = 0;
      registry.register('sla.breach', async () => void count++);

      const scheduler = new InlineJobScheduler(clock, registry);
      const at = (m: number) => new Date(Date.parse('2026-08-09T10:00:00Z') + m * 60_000);
      await scheduler.schedule('sla.breach', {}, at(5), { dedupeId: 'item:1' });
      await scheduler.schedule('sla.breach', {}, at(10), { dedupeId: 'item:1' }); // replaced

      clock.advance(6 * 60 * 1000);
      expect(await scheduler.drainDue()).toBe(0); // original 5-min timer is gone
      clock.advance(5 * 60 * 1000);
      expect(await scheduler.drainDue()).toBe(1);
      expect(count).toBe(1);
    });
  });
});
