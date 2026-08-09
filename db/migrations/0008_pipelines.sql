-- Up Migration

-- Migration group 040: pipelines, tasks, activity, matching. Domain model §5.

CREATE TABLE core.pipeline (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('supply','demand')),
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.pipeline_stage (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id    uuid NOT NULL REFERENCES core.pipeline(id),
  position       integer NOT NULL,
  name           text NOT NULL,
  entry_criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
  exit_criteria  jsonb NOT NULL DEFAULT '{}'::jsonb,
  sla_minutes    integer,
  UNIQUE (pipeline_id, position),
  UNIQUE (pipeline_id, name)
);

CREATE TABLE core.pipeline_item (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id            uuid NOT NULL REFERENCES core.pipeline(id),
  stage_id               uuid NOT NULL REFERENCES core.pipeline_stage(id),
  contact_id             uuid NOT NULL REFERENCES core.contact(id),
  property_id            uuid REFERENCES core.property(id),
  assigned_to            uuid REFERENCES core.contact(id),
  score                  numeric NOT NULL DEFAULT 0,
  state                  text NOT NULL DEFAULT 'open' CHECK (state IN ('open','won','lost')),
  stage_entered_at       timestamptz NOT NULL DEFAULT now(),
  sla_due_at             timestamptz,
  first_response_due_at  timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  sync_seq               bigint NOT NULL DEFAULT nextval('core.sync_seq')
);

CREATE TRIGGER pipeline_item_stamp_sync BEFORE UPDATE ON core.pipeline_item
  FOR EACH ROW EXECUTE FUNCTION core.stamp_sync();

CREATE INDEX pipeline_item_sla_idx ON core.pipeline_item (sla_due_at)
  WHERE sla_due_at IS NOT NULL;
CREATE INDEX pipeline_item_first_response_idx ON core.pipeline_item (first_response_due_at)
  WHERE first_response_due_at IS NOT NULL;
CREATE INDEX pipeline_item_queue_idx ON core.pipeline_item (assigned_to, stage_id);
CREATE INDEX pipeline_item_contact_idx ON core.pipeline_item (contact_id);

CREATE TABLE core.stage_transition (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid NOT NULL REFERENCES core.pipeline_item(id),
  from_stage_id uuid REFERENCES core.pipeline_stage(id),
  to_stage_id   uuid NOT NULL REFERENCES core.pipeline_stage(id),
  actor_id      uuid,
  reason        text,
  at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stage_transition_item_idx ON core.stage_transition (item_id, at);

CREATE TABLE core.task (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid REFERENCES core.pipeline_item(id),
  assignee_id   uuid,
  kind          text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  due_at        timestamptz,
  snoozed_until timestamptz,
  state         text NOT NULL DEFAULT 'open' CHECK (state IN ('open','done','escalated','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_assignee_idx ON core.task (assignee_id, state);
CREATE INDEX task_item_idx ON core.task (item_id);

-- The unified timeline every module writes to (contact AND property views).
CREATE TABLE core.activity (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  uuid,
  property_id uuid,
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id    uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_contact_idx ON core.activity (contact_id, occurred_at DESC)
  WHERE contact_id IS NOT NULL;
CREATE INDEX activity_property_idx ON core.activity (property_id, occurred_at DESC)
  WHERE property_id IS NOT NULL;

CREATE TABLE core.requirement_profile (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id    uuid NOT NULL REFERENCES core.contact(id),
  name          text,
  channel       text NOT NULL CHECK (channel IN ('sale','rent')),
  budget_min    numeric(12,2),
  budget_max    numeric(12,2),
  currency      char(3) NOT NULL DEFAULT 'EUR',
  areas         geography(MultiPolygon, 4326),
  postcodes     text[],
  bedrooms_min  integer,
  must_haves    jsonb NOT NULL DEFAULT '[]'::jsonb,
  deal_breakers jsonb NOT NULL DEFAULT '[]'::jsonb,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  sync_seq      bigint NOT NULL DEFAULT nextval('core.sync_seq')
);

CREATE TRIGGER requirement_profile_stamp_sync BEFORE UPDATE ON core.requirement_profile
  FOR EACH ROW EXECUTE FUNCTION core.stamp_sync();

CREATE INDEX requirement_profile_areas_idx ON core.requirement_profile USING gist (areas)
  WHERE active;
CREATE INDEX requirement_profile_contact_idx ON core.requirement_profile (contact_id);

CREATE TABLE core.match (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES core.requirement_profile(id),
  listing_id uuid NOT NULL REFERENCES core.listing(id),
  score      numeric NOT NULL DEFAULT 0,
  state      text NOT NULL DEFAULT 'new' CHECK (state IN ('new','alerted','dismissed','interested')),
  feedback   jsonb,
  matched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, listing_id)
);

CREATE INDEX match_listing_idx ON core.match (listing_id);
CREATE INDEX match_profile_idx ON core.match (profile_id, state);

-- Default pipelines: configuration data, seeded idempotently.
INSERT INTO core.pipeline (kind, name) VALUES
  ('supply', 'default_supply'),
  ('demand', 'default_demand')
ON CONFLICT (name) DO NOTHING;

INSERT INTO core.pipeline_stage (pipeline_id, position, name, sla_minutes)
SELECT p.id, s.position, s.name, s.sla_minutes
FROM core.pipeline p
JOIN (VALUES
  ('default_supply', 1, 'new_lead',          1440),
  ('default_supply', 2, 'contacted',         NULL),
  ('default_supply', 3, 'owner_engaged',     NULL),
  ('default_supply', 4, 'verified',          NULL),
  ('default_supply', 5, 'live_managed',      NULL),
  ('default_demand', 1, 'inquiry',           NULL),
  ('default_demand', 2, 'qualified',         2880),
  ('default_demand', 3, 'viewing_scheduled', NULL),
  ('default_demand', 4, 'offer',             NULL),
  ('default_demand', 5, 'closed',            NULL)
) AS s(pipeline_name, position, name, sla_minutes)
  ON s.pipeline_name = p.name
ON CONFLICT (pipeline_id, name) DO NOTHING;

-- Down Migration

DROP TABLE core.match;
DROP TABLE core.requirement_profile;
DROP TABLE core.activity;
DROP TABLE core.task;
DROP TABLE core.stage_transition;
DROP TABLE core.pipeline_item;
DROP TABLE core.pipeline_stage;
DROP TABLE core.pipeline;
