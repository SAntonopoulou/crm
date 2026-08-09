-- Up Migration

-- Migration group 010: contacts & identity. See docs/domain-model.md §2.

CREATE TABLE core.contact (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idp_subject_id        text UNIQUE,
  lifecycle_state       text NOT NULL DEFAULT 'unregistered'
    CHECK (lifecycle_state IN ('unregistered','invited','registered','identity_verified','suspended','erased')),
  display_name          text,
  locale                text NOT NULL DEFAULT 'en' CHECK (locale IN ('fr','nl','en')),
  timezone              text NOT NULL DEFAULT 'Europe/Brussels',
  processing_restricted boolean NOT NULL DEFAULT false,
  dek_id                uuid,
  merged_into           uuid REFERENCES core.contact(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  sync_seq              bigint NOT NULL DEFAULT nextval('core.sync_seq')
);

CREATE TRIGGER contact_stamp_sync BEFORE UPDATE ON core.contact
  FOR EACH ROW EXECUTE FUNCTION core.stamp_sync();

CREATE INDEX contact_sync_seq_idx ON core.contact (sync_seq);
CREATE INDEX contact_lifecycle_idx ON core.contact (lifecycle_state);

CREATE TABLE core.contact_role (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   uuid NOT NULL REFERENCES core.contact(id),
  role         text NOT NULL CHECK (role IN ('owner','buyer','renter','agent','staff')),
  state        text NOT NULL DEFAULT 'active' CHECK (state IN ('active','dormant','ended')),
  activated_at timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz
);

CREATE UNIQUE INDEX contact_role_live_uq
  ON core.contact_role (contact_id, role) WHERE state <> 'ended';

CREATE TABLE core.contact_channel (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id         uuid NOT NULL REFERENCES core.contact(id),
  kind               text NOT NULL CHECK (kind IN ('email','phone')),
  value_normalised   text NOT NULL,
  verification_state text NOT NULL DEFAULT 'unverified'
    CHECK (verification_state IN ('unverified','pending','verified','bounced')),
  is_preferred       boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, kind, value_normalised)
);

CREATE UNIQUE INDEX contact_channel_preferred_uq
  ON core.contact_channel (contact_id, kind) WHERE is_preferred;
CREATE INDEX contact_channel_value_idx ON core.contact_channel (value_normalised);
CREATE INDEX contact_channel_value_trgm
  ON core.contact_channel USING gin (value_normalised gin_trgm_ops);

-- KMS-encrypted direct identifiers, isolated from the main row.
CREATE TABLE core.contact_sensitive (
  contact_id      uuid PRIMARY KEY REFERENCES core.contact(id),
  national_id_enc bytea,
  iban_enc        bytea,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.organisation (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('agency','corporate_landlord')),
  name                text NOT NULL,
  registration_number text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.org_membership (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      uuid NOT NULL REFERENCES core.contact(id),
  organisation_id uuid NOT NULL REFERENCES core.organisation(id),
  role_in_org     text NOT NULL,
  validity        daterange NOT NULL DEFAULT daterange(CURRENT_DATE, NULL)
);

CREATE TABLE core.contact_relationship (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_contact_id uuid NOT NULL REFERENCES core.contact(id),
  to_contact_id   uuid NOT NULL REFERENCES core.contact(id),
  kind            text NOT NULL CHECK (kind IN ('co_owner','power_of_attorney','tenant_of_record')),
  validity        daterange NOT NULL DEFAULT daterange(CURRENT_DATE, NULL),
  CHECK (from_contact_id <> to_contact_id)
);

-- Reversible merge audit: full snapshot of both parties for unmerge.
CREATE TABLE core.contact_merge (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  surviving_id       uuid NOT NULL REFERENCES core.contact(id),
  absorbed_id        uuid NOT NULL REFERENCES core.contact(id),
  pre_merge_snapshot jsonb NOT NULL,
  merged_at          timestamptz NOT NULL DEFAULT now(),
  merged_by          uuid,
  unmerged_at        timestamptz
);

CREATE INDEX contact_merge_parties_idx
  ON core.contact_merge (surviving_id, absorbed_id);

-- Down Migration

DROP TABLE core.contact_merge;
DROP TABLE core.contact_relationship;
DROP TABLE core.org_membership;
DROP TABLE core.organisation;
DROP TABLE core.contact_sensitive;
DROP TABLE core.contact_channel;
DROP TABLE core.contact_role;
DROP TABLE core.contact;
