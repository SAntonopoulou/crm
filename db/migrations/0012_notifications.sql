-- Up Migration

-- Migration group 080a: notifications. Domain model §12.

CREATE TABLE core.device (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id          uuid NOT NULL REFERENCES core.contact(id),
  install_id          text NOT NULL UNIQUE,
  push_token          text,
  platform            text NOT NULL CHECK (platform IN ('ios','android','web')),
  app_version         text,
  locale              text,
  os_permission_state text CHECK (os_permission_state IN ('granted','denied','provisional','undetermined')),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  state               text NOT NULL DEFAULT 'active' CHECK (state IN ('active','pruned')),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX device_contact_idx ON core.device (contact_id)
  WHERE state = 'active';

CREATE TABLE core.notification (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      uuid NOT NULL REFERENCES core.contact(id),
  category        text NOT NULL CHECK (category IN ('transactional','marketing')),
  priority        text NOT NULL CHECK (priority IN ('critical_ack','high','normal','digest')),
  kind            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at timestamptz,
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','delivering','acked','exhausted','dead_letter')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_active_idx ON core.notification (created_at)
  WHERE state IN ('pending','delivering');
CREATE INDEX notification_contact_idx ON core.notification (contact_id, created_at DESC);

CREATE TABLE core.delivery_attempt (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id     uuid NOT NULL REFERENCES core.notification(id),
  step                integer NOT NULL,
  channel             text NOT NULL CHECK (channel IN ('push','sms','email')),
  device_id           uuid REFERENCES core.device(id),
  state               text NOT NULL DEFAULT 'queued' CHECK (state IN
    ('queued','sent','delivered','failed','bounced')),
  provider_message_id text,
  next_escalation_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX delivery_attempt_notification_idx
  ON core.delivery_attempt (notification_id, step);
CREATE INDEX delivery_attempt_escalation_idx
  ON core.delivery_attempt (next_escalation_at)
  WHERE next_escalation_at IS NOT NULL;

CREATE TABLE core.notification_preference (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        uuid NOT NULL REFERENCES core.contact(id),
  channel           text NOT NULL CHECK (channel IN ('push','sms','email')),
  category          text NOT NULL CHECK (category IN ('transactional','marketing')),
  device_install_id text,
  opted_out         boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX notification_preference_global_uq
  ON core.notification_preference (contact_id, channel, category)
  WHERE device_install_id IS NULL;
CREATE UNIQUE INDEX notification_preference_device_uq
  ON core.notification_preference (contact_id, channel, category, device_install_id)
  WHERE device_install_id IS NOT NULL;

-- Down Migration

DROP TABLE core.notification_preference;
DROP TABLE core.delivery_attempt;
DROP TABLE core.notification;
DROP TABLE core.device;
