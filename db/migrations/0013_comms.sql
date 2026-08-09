-- Up Migration

-- Migration group 080b: communications. Domain model §6.

CREATE TABLE core.conversation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      uuid NOT NULL REFERENCES core.contact(id),
  property_id     uuid REFERENCES core.property(id),
  topic           text,
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  sync_seq        bigint NOT NULL DEFAULT nextval('core.sync_seq')
);

CREATE TRIGGER conversation_stamp_sync BEFORE UPDATE ON core.conversation
  FOR EACH ROW EXECUTE FUNCTION core.stamp_sync();

CREATE INDEX conversation_contact_idx ON core.conversation (contact_id, last_message_at DESC);

CREATE TABLE core.template (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key      text NOT NULL UNIQUE,
  category text NOT NULL CHECK (category IN ('transactional','marketing'))
);

CREATE TABLE core.template_version (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  uuid NOT NULL REFERENCES core.template(id),
  version      integer NOT NULL,
  locale       text NOT NULL DEFAULT 'en',
  body         text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version, locale)
);

CREATE TABLE core.message (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     uuid NOT NULL REFERENCES core.conversation(id),
  direction           text NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel             text NOT NULL CHECK (channel IN ('email','sms','whatsapp','voice_note','in_app')),
  body                text,
  template_version_id uuid REFERENCES core.template_version(id),
  state               text NOT NULL CHECK (state IN
    ('received','gated','blocked','queued','sent','delivered','bounced','complained','failed')),
  provider_message_id text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);

CREATE INDEX message_conversation_idx ON core.message (conversation_id, created_at);
CREATE INDEX message_provider_idx ON core.message (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- The gate's persisted verdict: a message without a passing row here
-- can never reach a provider adapter (enforced as the only send path).
CREATE TABLE core.compliance_check (
  message_id      uuid PRIMARY KEY REFERENCES core.message(id),
  consent_ok      boolean NOT NULL,
  lawful_basis_ok boolean NOT NULL,
  suppression_ok  boolean NOT NULL,
  art14_required  boolean NOT NULL,
  verdict         text NOT NULL CHECK (verdict IN ('pass','blocked')),
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at      timestamptz NOT NULL DEFAULT now()
);

-- Per-country electronic-channel policy. DEFAULT IS BLOCK: a row with
-- allowed=true is a deliberate, legally signed-off unblock (runbook).
CREATE TABLE core.channel_policy (
  country char(2) NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  allowed boolean NOT NULL DEFAULT false,
  note    text,
  PRIMARY KEY (country, channel)
);

CREATE TABLE core.sequence (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name     text NOT NULL UNIQUE,
  steps    jsonb NOT NULL,
  throttle jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled  boolean NOT NULL DEFAULT true
);

CREATE TABLE core.sequence_enrollment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id  uuid NOT NULL REFERENCES core.sequence(id),
  contact_id   uuid NOT NULL REFERENCES core.contact(id),
  current_step integer NOT NULL DEFAULT 0,
  state        text NOT NULL DEFAULT 'active' CHECK (state IN
    ('active','stopped_on_reply','completed','blocked_by_gate')),
  next_step_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, contact_id)
);

CREATE INDEX sequence_enrollment_due_idx ON core.sequence_enrollment (next_step_at)
  WHERE state = 'active';

-- Article 14 disclosure with proof of delivery (the message that carried it).
CREATE TABLE core.disclosure (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   uuid NOT NULL REFERENCES core.contact(id),
  kind         text NOT NULL DEFAULT 'article_14' CHECK (kind IN ('article_14')),
  message_id   uuid NOT NULL REFERENCES core.message(id),
  delivered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, kind)
);

-- Consent (pulled forward from group 090: the gate consumes it; the
-- privacy module completes it with wording versions and withdrawal UX).
CREATE TABLE privacy.consent (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      uuid NOT NULL REFERENCES core.contact(id),
  purpose         text NOT NULL,
  wording_version text NOT NULL DEFAULT 'v1',
  granted_at      timestamptz NOT NULL DEFAULT now(),
  withdrawn_at    timestamptz,
  proof           jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX consent_contact_purpose_idx ON privacy.consent (contact_id, purpose)
  WHERE withdrawn_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA privacy TO crm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA privacy
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;

-- Down Migration

DROP TABLE privacy.consent;
DROP TABLE core.disclosure;
DROP TABLE core.sequence_enrollment;
DROP TABLE core.sequence;
DROP TABLE core.channel_policy;
DROP TABLE core.compliance_check;
DROP TABLE core.message;
DROP TABLE core.template_version;
DROP TABLE core.template;
DROP TABLE core.conversation;
