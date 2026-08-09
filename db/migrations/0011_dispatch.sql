-- Up Migration

-- Migration group 070: dispatch, claim, attribution. Domain model §9-10.

CREATE TABLE core.dispatch (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id   uuid NOT NULL REFERENCES core.appointment(id),
  strategy         text NOT NULL CHECK (strategy IN ('waterfall','broadcast','hybrid')),
  config_snapshot  jsonb NOT NULL DEFAULT '{}'::jsonb,
  state            text NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','offering','claimed','no_agent','cancelled')),
  escalation_rung  integer NOT NULL DEFAULT 0,
  -- The atomic guard: exactly one offer can ever land here.
  winning_offer_id uuid,
  claimed_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  sync_seq         bigint NOT NULL DEFAULT nextval('core.sync_seq')
);

CREATE TRIGGER dispatch_stamp_sync BEFORE UPDATE ON core.dispatch
  FOR EACH ROW EXECUTE FUNCTION core.stamp_sync();

-- One live dispatch per appointment; history preserved.
CREATE UNIQUE INDEX dispatch_live_uq ON core.dispatch (appointment_id)
  WHERE state IN ('pending','offering');
CREATE INDEX dispatch_live_board_idx ON core.dispatch (created_at)
  WHERE state IN ('pending','offering');

-- Every candidate considered, with score components: the Art 22
-- explanation trail and the dispatch audit in one table.
CREATE TABLE core.dispatch_candidate (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id      uuid NOT NULL REFERENCES core.dispatch(id),
  agent_id         uuid NOT NULL REFERENCES core.agent_profile(contact_id),
  rank             integer NOT NULL,
  score            numeric NOT NULL,
  score_components jsonb NOT NULL,
  excluded_reason  text,
  considered_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dispatch_id, agent_id)
);

CREATE TABLE core.dispatch_offer (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id    uuid NOT NULL REFERENCES core.dispatch(id),
  agent_id       uuid NOT NULL REFERENCES core.agent_profile(contact_id),
  state          text NOT NULL DEFAULT 'sent' CHECK (state IN
    ('sent','seen','claimed','declined','expired','withdrawn')),
  ttl_expires_at timestamptz NOT NULL,
  responded_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dispatch_id, agent_id)
);

CREATE INDEX dispatch_offer_agent_recent_idx ON core.dispatch_offer (agent_id, created_at DESC);
CREATE INDEX dispatch_offer_dispatch_idx ON core.dispatch_offer (dispatch_id) INCLUDE (state);
CREATE INDEX dispatch_offer_open_idx ON core.dispatch_offer (agent_id)
  WHERE state IN ('sent','seen');

CREATE TABLE core.assignment_agreement (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id            uuid NOT NULL UNIQUE REFERENCES core.dispatch_offer(id),
  agent_id            uuid NOT NULL REFERENCES core.agent_profile(contact_id),
  appointment_id      uuid NOT NULL REFERENCES core.appointment(id),
  terms_snapshot      jsonb NOT NULL,
  terms_version_id    uuid REFERENCES core.terms_version(id),
  accepted_at         timestamptz NOT NULL,
  ip                  inet,
  device_fingerprint  text,
  exclusivity_ends_at timestamptz NOT NULL
);

CREATE INDEX assignment_agreement_agent_idx ON core.assignment_agreement (agent_id);

-- Every agent interaction snapshot — future split policies compute over
-- this without migration (locked decision: sole credit inside the window).
CREATE TABLE core.lead_touch (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         uuid NOT NULL,
  buyer_contact_id uuid NOT NULL,
  property_id      uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('claim','showing','call','message','offer_assist')),
  at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX lead_touch_lead_idx ON core.lead_touch (buyer_contact_id, property_id, at);

CREATE TABLE core.attribution (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id     uuid NOT NULL REFERENCES core.assignment_agreement(id),
  buyer_contact_id uuid NOT NULL,
  property_id      uuid NOT NULL,
  state            text NOT NULL DEFAULT 'active' CHECK (state IN
    ('active','converted','expired','disputed','revoked')),
  window_ends_at   timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attribution_lead_idx ON core.attribution (buyer_contact_id, property_id)
  WHERE state = 'active';

CREATE TABLE core.dispute (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attribution_id uuid NOT NULL REFERENCES core.attribution(id),
  raised_by      uuid NOT NULL,
  evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  state          text NOT NULL DEFAULT 'open' CHECK (state IN ('open','under_review','resolved')),
  resolution     jsonb,
  resolved_by    uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.commission_statement (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attribution_id uuid NOT NULL REFERENCES core.attribution(id),
  deal_value     numeric(12,2) NOT NULL,
  rate_snapshot  jsonb NOT NULL,
  amount         numeric(12,2) NOT NULL,
  currency       char(3) NOT NULL DEFAULT 'EUR',
  state          text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','issued','settled_externally')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Purpose-bound temporal grants (pulled forward from group 090: the claim
-- creates them). Enforcement middleware and revocation land with #24.
CREATE TABLE core.access_grant (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grantee_agent_id   uuid NOT NULL,
  subject_contact_id uuid NOT NULL,
  appointment_id     uuid NOT NULL REFERENCES core.appointment(id),
  purpose            text NOT NULL DEFAULT 'claimed_showing',
  during             tstzrange NOT NULL,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX access_grant_live_idx
  ON core.access_grant (grantee_agent_id, subject_contact_id)
  WHERE revoked_at IS NULL;

-- Down Migration

DROP TABLE core.access_grant;
DROP TABLE core.commission_statement;
DROP TABLE core.dispute;
DROP TABLE core.attribution;
DROP TABLE core.lead_touch;
DROP TABLE core.assignment_agreement;
DROP TABLE core.dispatch_offer;
DROP TABLE core.dispatch_candidate;
DROP TABLE core.dispatch;
