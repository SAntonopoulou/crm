-- Up Migration

-- Migration group 050: appointments, access rules, holds. Domain model §7.

CREATE TABLE core.property_access_rule (
  property_id           uuid PRIMARY KEY REFERENCES core.property(id),
  occupancy             text CHECK (occupancy IN ('vacant','owner_occupied','tenanted')),
  min_notice_hours      integer,
  key_holder_contact_id uuid REFERENCES core.contact(id),
  lockbox_ref           text,
  viewing_hours         jsonb NOT NULL DEFAULT '{"start":"09:00","end":"19:00"}'::jsonb,
  slot_minutes          integer NOT NULL DEFAULT 60,
  blackout_windows      jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.slot_hold (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       uuid NOT NULL REFERENCES core.property(id),
  listing_id        uuid NOT NULL REFERENCES core.listing(id),
  viewer_contact_id uuid NOT NULL REFERENCES core.contact(id),
  during            tstzrange NOT NULL,
  expires_at        timestamptz NOT NULL,
  state             text NOT NULL DEFAULT 'held'
    CHECK (state IN ('held','converted','released','expired')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- A live hold blocks the range at the database layer.
ALTER TABLE core.slot_hold ADD CONSTRAINT slot_hold_no_overlap
  EXCLUDE USING gist (property_id WITH =, during WITH &&)
  WHERE (state = 'held');

CREATE INDEX slot_hold_expiry_idx ON core.slot_hold (expires_at)
  WHERE state = 'held';

CREATE TABLE core.appointment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       uuid NOT NULL REFERENCES core.property(id),
  listing_id        uuid NOT NULL REFERENCES core.listing(id),
  viewer_contact_id uuid NOT NULL REFERENCES core.contact(id),
  agent_id          uuid REFERENCES core.contact(id),
  during            tstzrange NOT NULL,
  kind              text NOT NULL DEFAULT 'private' CHECK (kind IN ('private','open_house')),
  capacity          integer,
  state             text NOT NULL DEFAULT 'dispatching' CHECK (state IN
    ('dispatching','unstaffed','booked','confirmed','in_progress',
     'completed','outcome_captured','cancelled','no_show')),
  cancelled_by      text CHECK (cancelled_by IN ('viewer','agent','staff')),
  cancel_reason     text,
  penalty_applied   boolean,
  one_time_code     text,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  sync_seq          bigint NOT NULL DEFAULT nextval('core.sync_seq')
);

CREATE TRIGGER appointment_stamp_sync BEFORE UPDATE ON core.appointment
  FOR EACH ROW EXECUTE FUNCTION core.stamp_sync();

-- Double-booking is impossible at the database layer, not just app logic.
ALTER TABLE core.appointment ADD CONSTRAINT appointment_no_property_overlap
  EXCLUDE USING gist (property_id WITH =, during WITH &&)
  WHERE (state IN ('dispatching','unstaffed','booked','confirmed','in_progress'));
ALTER TABLE core.appointment ADD CONSTRAINT appointment_no_agent_overlap
  EXCLUDE USING gist (agent_id WITH =, during WITH &&)
  WHERE (agent_id IS NOT NULL AND state IN ('booked','confirmed','in_progress'));

CREATE INDEX appointment_viewer_idx ON core.appointment (viewer_contact_id, created_at);
CREATE INDEX appointment_agent_idx ON core.appointment (agent_id)
  WHERE agent_id IS NOT NULL;
CREATE INDEX appointment_sync_idx ON core.appointment (sync_seq);
CREATE INDEX appointment_state_idx ON core.appointment (state);

CREATE TABLE core.attendance_proof (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES core.appointment(id),
  party          text NOT NULL CHECK (party IN ('agent','viewer')),
  direction      text NOT NULL CHECK (direction IN ('check_in','check_out')),
  method         text NOT NULL CHECK (method IN ('geofence','one_time_code')),
  evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, party, direction)
);

CREATE TABLE core.appointment_feedback (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id    uuid NOT NULL REFERENCES core.appointment(id),
  author_role       text NOT NULL CHECK (author_role IN ('agent','viewer')),
  structured        jsonb NOT NULL DEFAULT '{}'::jsonb,
  shared_with_owner boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, author_role)
);

CREATE TABLE core.viewing_outcome (
  appointment_id          uuid PRIMARY KEY REFERENCES core.appointment(id),
  outcome                 text NOT NULL CHECK (outcome IN
    ('interested','offer_intent','rejected','no_show_viewer','no_show_agent')),
  notes                   text,
  routed_pipeline_item_id uuid,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.waitlist_entry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES core.appointment(id),
  contact_id     uuid NOT NULL REFERENCES core.contact(id),
  position       integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, contact_id)
);

-- Down Migration

DROP TABLE core.waitlist_entry;
DROP TABLE core.viewing_outcome;
DROP TABLE core.appointment_feedback;
DROP TABLE core.attendance_proof;
DROP TABLE core.appointment;
DROP TABLE core.slot_hold;
DROP TABLE core.property_access_rule;
