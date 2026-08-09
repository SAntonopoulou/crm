-- Up Migration

-- Migration group 030: ingest, quarantine, suppression. Domain model §4.

CREATE TABLE core.source (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL UNIQUE,
  kind                 text NOT NULL CHECK (kind IN ('portal_scrape','owner_submission','staff_entry')),
  default_lawful_basis text NOT NULL DEFAULT 'legitimate_interest',
  enabled              boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.ingest_run (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES core.source(id),
  idempotency_key text NOT NULL,
  request_hash    text NOT NULL,
  status          text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed')),
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  UNIQUE (source_id, idempotency_key)
);

CREATE TABLE core.ingest_record (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES core.ingest_run(id),
  source_id         uuid NOT NULL REFERENCES core.source(id),
  idempotency_key   text NOT NULL,
  dedupe_key        text,
  kind              text NOT NULL CHECK (kind IN ('property_listing','owner_contact','combined')),
  payload           jsonb,
  outcome           text CHECK (outcome IN ('created','updated','unchanged','quarantined','suppressed','failed')),
  problem_code      text,
  quarantine_reason text,
  property_id       uuid,
  contact_id        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, idempotency_key)
);

CREATE INDEX ingest_record_run_idx ON core.ingest_record (run_id);

CREATE TABLE core.quarantine_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingest_record_id uuid NOT NULL REFERENCES core.ingest_record(id),
  reason           text NOT NULL CHECK (reason IN ('low_confidence','contradiction','near_duplicate')),
  state            text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','rejected')),
  reviewed_by      uuid,
  resolution       jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX quarantine_pending_idx ON core.quarantine_item (created_at)
  WHERE state = 'pending';

-- Keyed HMACs only — the suppression list must not itself retain the PII
-- it exists to erase.
CREATE TABLE core.suppression_entry (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('email','phone','address_key','idp_subject')),
  value_hmac text NOT NULL UNIQUE,
  reason     text NOT NULL DEFAULT 'erasure' CHECK (reason IN ('erasure','objection')),
  dsr_id     uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE core.suppression_entry;
DROP TABLE core.quarantine_item;
DROP TABLE core.ingest_record;
DROP TABLE core.ingest_run;
DROP TABLE core.source;
