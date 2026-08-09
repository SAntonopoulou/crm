-- Up Migration

-- Migration group 110: portfolio (client-team scope addition, 2026-08-09).
-- Investor-entered figures ONLY. current_value_estimate is never a
-- write-time column; last_value_estimate is event bookkeeping so
-- portfolio.valuation_updated fires only on actual change.

CREATE TABLE core.portfolio_entry (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id            uuid NOT NULL REFERENCES core.contact(id),
  property_id           uuid NOT NULL REFERENCES core.property(id),
  purchase_price        numeric(12,2) NOT NULL,
  monthly_rental_income numeric(12,2) NOT NULL,
  monthly_expenses      numeric(12,2) NOT NULL,
  currency              char(3) NOT NULL DEFAULT 'EUR',
  status                text NOT NULL DEFAULT 'watching'
    CHECK (status IN ('watching','offer_made','owned')),
  added_at              timestamptz NOT NULL DEFAULT now(),
  last_value_estimate   numeric(12,2),
  last_estimated_at     timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  sync_seq              bigint NOT NULL DEFAULT nextval('core.sync_seq'),
  UNIQUE (contact_id, property_id)
);

CREATE TRIGGER portfolio_entry_stamp_sync BEFORE UPDATE ON core.portfolio_entry
  FOR EACH ROW EXECUTE FUNCTION core.stamp_sync();

CREATE INDEX portfolio_entry_contact_idx ON core.portfolio_entry (contact_id, added_at);
CREATE INDEX portfolio_entry_sync_idx ON core.portfolio_entry (sync_seq);

-- Down Migration

DROP TABLE core.portfolio_entry;
