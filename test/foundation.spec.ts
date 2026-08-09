import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

describe('foundation (migration group 000)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('has PostGIS and the required extensions', async () => {
    const { rows } = await pool.query(
      `SELECT extname FROM pg_extension
        WHERE extname IN ('postgis', 'btree_gist', 'pg_trgm', 'pgcrypto')`,
    );
    expect(rows.map((r) => r.extname).sort()).toEqual([
      'btree_gist',
      'pg_trgm',
      'pgcrypto',
      'postgis',
    ]);
  });

  it('outbox events get strictly monotonic sequence numbers', async () => {
    const insert = () =>
      pool.query(
        `INSERT INTO core.outbox_event (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('smoke', gen_random_uuid(), 'smoke.test', '{}') RETURNING seq`,
      );
    const a = await insert();
    const b = await insert();
    expect(Number(b.rows[0].seq)).toBeGreaterThan(Number(a.rows[0].seq));
  });

  it('tombstones consume the same global sync sequence as stamped rows', async () => {
    const before = await pool.query(`SELECT last_value FROM core.sync_seq`);
    const { rows } = await pool.query(
      `INSERT INTO core.tombstone (entity_type, entity_id)
       VALUES ('smoke', gen_random_uuid()) RETURNING sync_seq`,
    );
    expect(Number(rows[0].sync_seq)).toBeGreaterThanOrEqual(
      Number(before.rows[0].last_value),
    );
  });

  it('duplicate idempotency keys are rejected per actor', async () => {
    const actor = (
      await pool.query(`SELECT gen_random_uuid() AS id`)
    ).rows[0].id;
    const insert = () =>
      pool.query(
        `INSERT INTO core.idempotency_key (key, actor_id, request_hash, expires_at)
         VALUES ('k1', $1, 'h1', now() + interval '1 day')`,
        [actor],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });
});
