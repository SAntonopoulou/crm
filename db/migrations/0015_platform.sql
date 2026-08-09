-- Up Migration

-- Platform completion: offer sync support, iCal tokens, upload
-- sessions, webhook subscriptions (migration-plan group 100).

-- Offers are a synced resource in the client contract; they need the
-- global sequence like every other synced table.
ALTER TABLE core.dispatch_offer
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN sync_seq bigint NOT NULL DEFAULT nextval('core.sync_seq');

CREATE TRIGGER dispatch_offer_stamp_sync BEFORE UPDATE ON core.dispatch_offer
  FOR EACH ROW EXECUTE FUNCTION core.stamp_sync();

CREATE INDEX dispatch_offer_sync_idx ON core.dispatch_offer (sync_seq);

-- Tokenised read-only calendar feed per agent.
ALTER TABLE core.agent_profile
  ADD COLUMN ical_token text UNIQUE DEFAULT gen_random_uuid()::text;

-- Resumable-upload sessions; bytes land behind a StoragePort.
CREATE TABLE core.upload_session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   uuid NOT NULL REFERENCES core.contact(id),
  purpose      text NOT NULL CHECK (purpose IN ('listing_media','agent_document','property_document')),
  filename     text NOT NULL,
  content_type text NOT NULL,
  size_bytes   bigint NOT NULL,
  storage_key  text,
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','uploaded')),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX upload_session_contact_idx ON core.upload_session (contact_id, created_at);

-- Webhook consumers of the outbox stream (the client-side team's backend).
CREATE TABLE core.webhook_subscription (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer    text NOT NULL,
  url         text NOT NULL,
  event_types text[] NOT NULL DEFAULT '{}',
  secret      text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.webhook_delivery (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES core.webhook_subscription(id),
  event_seq       bigint NOT NULL,
  event_id        uuid NOT NULL,
  state           text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','delivered','failed','dead')),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, event_id)
);

CREATE INDEX webhook_delivery_retry_idx ON core.webhook_delivery (created_at)
  WHERE state IN ('queued','failed');

-- Down Migration

DROP TABLE core.webhook_delivery;
DROP TABLE core.webhook_subscription;
DROP TABLE core.upload_session;
ALTER TABLE core.agent_profile DROP COLUMN ical_token;
DROP TRIGGER dispatch_offer_stamp_sync ON core.dispatch_offer;
DROP INDEX core.dispatch_offer_sync_idx;
ALTER TABLE core.dispatch_offer DROP COLUMN sync_seq, DROP COLUMN updated_at;
