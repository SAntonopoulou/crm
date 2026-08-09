-- Up Migration

-- #41 Calendar sync links (OAuth credentials encrypted at deploy; the
-- adapter owns token refresh).
CREATE TABLE core.calendar_link (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id             uuid NOT NULL REFERENCES core.agent_profile(contact_id),
  provider             text NOT NULL CHECK (provider IN ('google','outlook')),
  external_calendar_id text,
  credentials          jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_token           text,
  enabled              boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, provider)
);

CREATE TABLE core.calendar_event_link (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id    uuid NOT NULL REFERENCES core.appointment(id),
  calendar_link_id  uuid NOT NULL REFERENCES core.calendar_link(id),
  external_event_id text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, calendar_link_id)
);

-- #42 Account recovery: dual DISTINCT staff approval + payout cooldown.
CREATE TABLE core.recovery_request (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id                uuid NOT NULL REFERENCES core.contact(id),
  reason                    text,
  state                     text NOT NULL DEFAULT 'open' CHECK (state IN
    ('open','first_approved','approved','rejected','completed')),
  first_approver            uuid,
  second_approver           uuid,
  payout_change_unlocked_at timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (first_approver IS NULL OR second_approver IS NULL
         OR first_approver <> second_approver)
);

-- #42 Bulk-export controls: approval by a DIFFERENT staff member,
-- watermark embedded in the delivered artefact.
CREATE TABLE core.export_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by uuid NOT NULL,
  criteria     jsonb NOT NULL,
  state        text NOT NULL DEFAULT 'pending_approval' CHECK (state IN
    ('pending_approval','approved','rejected','delivered')),
  approved_by  uuid,
  watermark_id uuid NOT NULL DEFAULT gen_random_uuid(),
  storage_key  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

-- #43 Breach-notice templates: PLACEHOLDERS — final copy must come from
-- counsel (runbook launch checklist) before any real send.
INSERT INTO core.template (key, category)
VALUES ('breach_notice', 'transactional')
ON CONFLICT (key) DO NOTHING;

INSERT INTO core.template_version (template_id, version, locale, body)
SELECT t.id, 1, v.locale, v.body
FROM core.template t
JOIN (VALUES
  ('en', '[PENDING COUNSEL] We are writing to inform you of a data incident affecting your account. Details: {{summary}}.'),
  ('fr', '[EN ATTENTE DU CONSEIL JURIDIQUE] Nous vous informons d''un incident de données concernant votre compte. Détails : {{summary}}.'),
  ('nl', '[IN AFWACHTING VAN JURIDISCH ADVIES] Wij informeren u over een gegevensincident met betrekking tot uw account. Details: {{summary}}.')
) AS v(locale, body) ON t.key = 'breach_notice'
ON CONFLICT (template_id, version, locale) DO NOTHING;

-- Down Migration

DROP TABLE core.export_request;
DROP TABLE core.recovery_request;
DROP TABLE core.calendar_event_link;
DROP TABLE core.calendar_link;
