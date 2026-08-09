-- Up Migration

-- Field-level provenance: one row per (entity, field) holding the
-- provenance of the CURRENT value plus, when a lower-precedence write
-- lost, the parked candidate for staff review.

CREATE TABLE core.field_provenance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  field_name      text NOT NULL,
  source_id       uuid,
  method          text NOT NULL CHECK (method IN ('scraped', 'owner_submitted', 'staff_verified')),
  confidence      numeric CHECK (confidence >= 0 AND confidence <= 1),
  collected_at    timestamptz NOT NULL,
  candidate       jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, field_name)
);

-- Per-field overrides of the default precedence order.
CREATE TABLE core.field_precedence_rule (
  entity_type    text NOT NULL,
  field_name     text NOT NULL,
  method_ranking jsonb NOT NULL,
  PRIMARY KEY (entity_type, field_name)
);

-- Down Migration

DROP TABLE core.field_precedence_rule;
DROP TABLE core.field_provenance;
