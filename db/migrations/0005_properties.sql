-- Up Migration

-- Migration group 020: properties & listings. See docs/domain-model.md §3.

CREATE TABLE core.property (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_key      text NOT NULL UNIQUE,
  address_normalised jsonb NOT NULL,
  geo_point          geography(Point, 4326),
  timezone           text NOT NULL DEFAULT 'Europe/Brussels',
  kind               text CHECK (kind IN ('house','apartment','land','commercial','other')),
  tenure             text CHECK (tenure IN ('freehold','leasehold','unknown')),
  floor_area_sqm     numeric,
  bedrooms           integer,
  epc_rating         text CHECK (epc_rating IN ('A++','A+','A','B','C','D','E','F','G')),
  -- Occupancy is refined by property_access_rule (migration group 050);
  -- ingest can already learn it from listing copy, so it lives here too.
  occupancy          text CHECK (occupancy IN ('vacant','owner_occupied','tenanted')),
  features           jsonb NOT NULL DEFAULT '{}'::jsonb,
  free_attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,
  merged_into        uuid REFERENCES core.property(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  sync_seq           bigint NOT NULL DEFAULT nextval('core.sync_seq')
);

CREATE TRIGGER property_stamp_sync BEFORE UPDATE ON core.property
  FOR EACH ROW EXECUTE FUNCTION core.stamp_sync();

CREATE INDEX property_geo_idx ON core.property USING gist (geo_point);
CREATE INDEX property_sync_seq_idx ON core.property (sync_seq);
CREATE INDEX property_kind_idx ON core.property (kind);

CREATE TABLE core.listing (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL REFERENCES core.property(id),
  channel          text NOT NULL CHECK (channel IN ('sale','rent')),
  state            text NOT NULL DEFAULT 'discovered' CHECK (state IN
    ('discovered','contact_attempted','owner_reached','verified','live',
     'under_offer','sold','let','withdrawn','expired')),
  price            numeric(12,2),
  currency         char(3) NOT NULL DEFAULT 'EUR',
  description      text,
  source_url       text,
  state_entered_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  sync_seq         bigint NOT NULL DEFAULT nextval('core.sync_seq')
);

CREATE TRIGGER listing_stamp_sync BEFORE UPDATE ON core.listing
  FOR EACH ROW EXECUTE FUNCTION core.stamp_sync();

-- One ACTIVE listing per property per channel; history keeps its rows.
CREATE UNIQUE INDEX listing_active_uq ON core.listing (property_id, channel)
  WHERE state NOT IN ('sold','let','withdrawn','expired');
CREATE INDEX listing_state_idx ON core.listing (state, state_entered_at);
CREATE INDEX listing_sync_seq_idx ON core.listing (sync_seq);
CREATE INDEX listing_property_idx ON core.listing (property_id);

CREATE TABLE core.listing_change (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id    uuid NOT NULL REFERENCES core.listing(id),
  field         text NOT NULL,
  old_value     jsonb,
  new_value     jsonb,
  provenance_id uuid,
  changed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX listing_change_listing_idx ON core.listing_change (listing_id, changed_at);

CREATE TABLE core.property_party (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES core.property(id),
  contact_id      uuid NOT NULL REFERENCES core.contact(id),
  role            text NOT NULL CHECK (role IN ('owner','representative')),
  ownership_share numeric CHECK (ownership_share > 0 AND ownership_share <= 1),
  validity        daterange NOT NULL DEFAULT daterange(CURRENT_DATE, NULL)
);

CREATE INDEX property_party_property_idx ON core.property_party (property_id);
CREATE INDEX property_party_contact_idx ON core.property_party (contact_id);

CREATE TABLE core.property_document (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id        uuid NOT NULL REFERENCES core.property(id),
  kind               text NOT NULL CHECK (kind IN ('epc_certificate','floor_plan','title_deed','mandate')),
  storage_key        text NOT NULL,
  issued_at          date,
  expires_at         date,
  verification_state text NOT NULL DEFAULT 'pending'
    CHECK (verification_state IN ('pending','verified','rejected','expired')),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX property_document_expiry_idx ON core.property_document (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE core.media_asset (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES core.property(id),
  listing_id    uuid REFERENCES core.listing(id),
  kind          text NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo','video','plan')),
  url           text,
  storage_key   text,
  position      integer NOT NULL DEFAULT 0,
  caption       text,
  rights_status text NOT NULL DEFAULT 'scraped_unverified'
    CHECK (rights_status IN ('owned','licensed','scraped_unverified')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX media_asset_property_idx ON core.media_asset (property_id, position);

CREATE TABLE core.property_merge (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  surviving_id       uuid NOT NULL REFERENCES core.property(id),
  absorbed_id        uuid NOT NULL REFERENCES core.property(id),
  pre_merge_snapshot jsonb NOT NULL,
  merged_at          timestamptz NOT NULL DEFAULT now(),
  merged_by          uuid,
  unmerged_at        timestamptz
);

-- Down Migration

DROP TABLE core.property_merge;
DROP TABLE core.media_asset;
DROP TABLE core.property_document;
DROP TABLE core.property_party;
DROP TABLE core.listing_change;
DROP TABLE core.listing;
DROP TABLE core.property;
