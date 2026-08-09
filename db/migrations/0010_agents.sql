-- Up Migration

-- Migration group 060: agent registry. Domain model §8.

CREATE TABLE core.agent_profile (
  contact_id           uuid PRIMARY KEY REFERENCES core.contact(id),
  state                text NOT NULL DEFAULT 'invited' CHECK (state IN
    ('invited','onboarding','pending_review','active','suspended','rejected','offboarded')),
  suspension_reason    text CHECK (suspension_reason IN ('doc_lapse_auto','manual')),
  licence_number       text,
  licence_expires_at   date,
  insurance_expires_at date,
  languages            text[] NOT NULL DEFAULT '{}',
  specialisms          text[] NOT NULL DEFAULT '{}',
  capacity_max_active  integer NOT NULL DEFAULT 10,
  working_hours        jsonb NOT NULL DEFAULT '{}'::jsonb,
  commission_terms     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  sync_seq             bigint NOT NULL DEFAULT nextval('core.sync_seq')
);

CREATE TRIGGER agent_profile_stamp_sync BEFORE UPDATE ON core.agent_profile
  FOR EACH ROW EXECUTE FUNCTION core.stamp_sync();

-- The dispatch candidate pool: suspension falls out of this index.
CREATE INDEX agent_profile_active_idx ON core.agent_profile (contact_id)
  WHERE state = 'active';

CREATE TABLE core.agent_document (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           uuid NOT NULL REFERENCES core.agent_profile(contact_id),
  kind               text NOT NULL CHECK (kind IN ('licence','insurance','id_document')),
  storage_key        text NOT NULL,
  expires_at         date,
  verification_state text NOT NULL DEFAULT 'pending'
    CHECK (verification_state IN ('pending','verified','rejected','lapsed')),
  verified_by        uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_document_agent_idx ON core.agent_document (agent_id, kind);

CREATE TABLE core.coverage_area (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id  uuid NOT NULL REFERENCES core.agent_profile(contact_id),
  area      geography(MultiPolygon, 4326),
  postcodes text[]
);

CREATE INDEX coverage_area_gist ON core.coverage_area USING gist (area);
CREATE INDEX coverage_area_agent_idx ON core.coverage_area (agent_id);

CREATE TABLE core.agent_absence (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES core.agent_profile(contact_id),
  during   tstzrange NOT NULL,
  reason   text
);

CREATE INDEX agent_absence_gist ON core.agent_absence USING gist (agent_id, during);

CREATE TABLE core.terms_version (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version        integer NOT NULL,
  locale         text NOT NULL DEFAULT 'en',
  body           text NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version, locale)
);

CREATE TABLE core.terms_acceptance (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           uuid NOT NULL REFERENCES core.agent_profile(contact_id),
  terms_version_id   uuid NOT NULL REFERENCES core.terms_version(id),
  accepted_at        timestamptz NOT NULL DEFAULT now(),
  ip                 inet,
  device_fingerprint text,
  UNIQUE (agent_id, terms_version_id)
);

INSERT INTO core.terms_version (version, locale, body)
VALUES (1, 'en', 'Agent terms v1 — placeholder pending legal copy.')
ON CONFLICT (version, locale) DO NOTHING;

-- Down Migration

DROP TABLE core.terms_acceptance;
DROP TABLE core.terms_version;
DROP TABLE core.agent_absence;
DROP TABLE core.coverage_area;
DROP TABLE core.agent_document;
DROP TABLE core.agent_profile;
