-- Up Migration

-- Migration group 090: privacy & GDPR completion. Domain model §12.

CREATE TABLE privacy.dsr (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id       uuid NOT NULL REFERENCES core.contact(id),
  kind             text NOT NULL CHECK (kind IN
    ('access','rectification','erasure','restriction','portability','objection')),
  detail           text,
  received_at      timestamptz NOT NULL,
  due_at           timestamptz NOT NULL,
  state            text NOT NULL DEFAULT 'received' CHECK (state IN
    ('received','identity_check','in_progress','escalated','completed','refused')),
  completion_audit jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dsr_deadline_idx ON privacy.dsr (due_at)
  WHERE state NOT IN ('completed','refused');
CREATE INDEX dsr_contact_idx ON privacy.dsr (contact_id);

CREATE TABLE privacy.erasure_propagation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dsr_id       uuid NOT NULL REFERENCES privacy.dsr(id),
  target       text NOT NULL CHECK (target IN ('keycloak','suppression_list','kms_dek','analytics_store')),
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','confirmed','failed')),
  detail       text,
  confirmed_at timestamptz
);

CREATE INDEX erasure_propagation_dsr_idx ON privacy.erasure_propagation (dsr_id);

CREATE TABLE privacy.retention_policy (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_category text NOT NULL UNIQUE,
  period_days   integer NOT NULL,
  trigger       text NOT NULL DEFAULT 'created_at'
);

CREATE TABLE privacy.purge_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_category text NOT NULL,
  purged_count  integer NOT NULL,
  ran_at        timestamptz NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE privacy.breach_incident (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at        timestamptz NOT NULL,
  notify_deadline_at timestamptz NOT NULL,
  state              text NOT NULL DEFAULT 'triage' CHECK (state IN
    ('triage','assessing','notified_dpa','notified_subjects','closed')),
  timeline           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Article 30 register, in-system.
CREATE TABLE privacy.processing_activity (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL UNIQUE,
  purpose          text NOT NULL,
  lawful_basis     text NOT NULL CHECK (lawful_basis IN ('consent','contract','legitimate_interest','legal_obligation')),
  lia_document_ref text,
  data_categories  text[] NOT NULL DEFAULT '{}',
  CHECK (lawful_basis <> 'legitimate_interest' OR lia_document_ref IS NOT NULL)
);

CREATE TABLE privacy.processor (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor             text NOT NULL,
  role               text NOT NULL CHECK (role IN ('processor','sub_processor')),
  dpa_status         text NOT NULL DEFAULT 'pending',
  transfer_mechanism text NOT NULL DEFAULT 'none_required'
);

-- Retention defaults (runbook §2 — pending DPO sign-off, launch blocker).
INSERT INTO privacy.retention_policy (data_category, period_days, trigger) VALUES
  ('unregistered_scraped_leads', 180, 'created_at'),
  ('ingest_payloads', 30, 'created_at')
ON CONFLICT (data_category) DO NOTHING;

INSERT INTO privacy.processing_activity (name, purpose, lawful_basis, lia_document_ref, data_categories) VALUES
  ('supply_acquisition', 'Contacting owners of scraped listings', 'legitimate_interest', 'LIA-2026-001 (draft, counsel review pending)', '{contact_channels,property_data}'),
  ('viewing_dispatch', 'Matching agents to booked viewings', 'contract', NULL, '{contact_channels,appointment_data,agent_profile}'),
  ('marketing', 'Listing alerts and newsletters', 'consent', NULL, '{contact_channels,requirement_profiles}')
ON CONFLICT (name) DO NOTHING;

-- Down Migration

DROP TABLE privacy.processor;
DROP TABLE privacy.processing_activity;
DROP TABLE privacy.breach_incident;
DROP TABLE privacy.purge_log;
DROP TABLE privacy.retention_policy;
DROP TABLE privacy.erasure_propagation;
DROP TABLE privacy.dsr;
