-- Up Migration

-- 000 foundation: extensions, schemas, roles, sync sequence, outbox,
-- idempotency, tombstones. See docs/migration-plan.md group 000.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS privacy;

-- Roles are cluster-wide; create idempotently, never dropped by Down.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_app') THEN
    CREATE ROLE crm_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_readonly') THEN
    CREATE ROLE crm_readonly NOLOGIN;
  END IF;
END
$$;

-- Global delta-sync sequence; stamped by trigger on every synced table.
CREATE SEQUENCE core.sync_seq;

CREATE FUNCTION core.stamp_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.sync_seq := nextval('core.sync_seq');
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Transactional outbox: written in the same tx as the domain change.
CREATE TABLE core.outbox_event (
  seq            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id             uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,
  schema_version int  NOT NULL DEFAULT 1,
  payload        jsonb NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz
);

CREATE INDEX outbox_event_unpublished_idx
  ON core.outbox_event (seq) WHERE published_at IS NULL;
CREATE INDEX outbox_event_aggregate_idx
  ON core.outbox_event (aggregate_type, aggregate_id, seq);

-- API idempotency-key store (24 h TTL enforced by sweep job).
CREATE TABLE core.idempotency_key (
  key             text NOT NULL,
  actor_id        uuid NOT NULL,
  request_hash    text NOT NULL,
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (actor_id, key)
);

CREATE INDEX idempotency_key_expiry_idx ON core.idempotency_key (expires_at);

-- Tombstones so deletions appear in delta sync.
CREATE TABLE core.tombstone (
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  sync_seq    bigint NOT NULL DEFAULT nextval('core.sync_seq'),
  deleted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id)
);

CREATE INDEX tombstone_sync_idx ON core.tombstone (sync_seq);

-- Application-role grants. audit schema gets INSERT-only grants when its
-- tables arrive (migration group 090); nothing to grant there yet.
GRANT USAGE ON SCHEMA core, privacy TO crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO crm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core TO crm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA core
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA core
  GRANT USAGE, SELECT ON SEQUENCES TO crm_app;

-- Down Migration

DROP TABLE core.tombstone;
DROP TABLE core.idempotency_key;
DROP TABLE core.outbox_event;
DROP FUNCTION core.stamp_sync();
DROP SEQUENCE core.sync_seq;
DROP SCHEMA privacy;
DROP SCHEMA audit;
DROP SCHEMA core;
