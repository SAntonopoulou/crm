-- Up Migration

-- Client-team delta (2026-08-09): investor-entered financing fields.
-- outstanding_debt is a stock (balance), monthly_mortgage_payment a flow —
-- deliberately separate; the client derives equity and net cash flow.

ALTER TABLE core.portfolio_entry
  ADD COLUMN outstanding_debt numeric(12,2),
  ADD COLUMN monthly_mortgage_payment numeric(12,2);

-- Down Migration

ALTER TABLE core.portfolio_entry
  DROP COLUMN monthly_mortgage_payment,
  DROP COLUMN outstanding_debt;
