-- Up Migration

-- audit.pii_access_log: append-only record of PII reads AND writes.
-- Monthly range partitions; the partition-maintenance job pre-creates
-- future partitions and the DEFAULT partition catches gaps so an
-- insert can never fail for lack of a partition.
-- The application role gets INSERT and SELECT only: append-only is a
-- property of the grants, not of application discipline.

CREATE TABLE audit.pii_access_log (
  seq                bigint GENERATED ALWAYS AS IDENTITY,
  actor_id           uuid NOT NULL,
  subject_contact_id uuid,
  entity_field       text NOT NULL,
  action             text NOT NULL CHECK (action IN ('read', 'reveal', 'write', 'export')),
  reason             text,
  request_context    jsonb NOT NULL DEFAULT '{}'::jsonb,
  at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seq, at)
) PARTITION BY RANGE (at);

CREATE TABLE audit.pii_access_log_2026_08 PARTITION OF audit.pii_access_log
  FOR VALUES FROM ('2026-08-01T00:00:00Z') TO ('2026-09-01T00:00:00Z');
CREATE TABLE audit.pii_access_log_2026_09 PARTITION OF audit.pii_access_log
  FOR VALUES FROM ('2026-09-01T00:00:00Z') TO ('2026-10-01T00:00:00Z');
CREATE TABLE audit.pii_access_log_default PARTITION OF audit.pii_access_log DEFAULT;

CREATE INDEX pii_access_log_subject_idx
  ON audit.pii_access_log (subject_contact_id, at DESC);
CREATE INDEX pii_access_log_actor_idx
  ON audit.pii_access_log (actor_id, at DESC);
CREATE INDEX pii_access_log_at_brin ON audit.pii_access_log USING brin (at);

GRANT USAGE ON SCHEMA audit TO crm_app;
GRANT INSERT, SELECT ON audit.pii_access_log TO crm_app;
GRANT USAGE ON SCHEMA audit TO crm_readonly;
GRANT SELECT ON audit.pii_access_log TO crm_readonly;

-- Down Migration

DROP TABLE audit.pii_access_log;
