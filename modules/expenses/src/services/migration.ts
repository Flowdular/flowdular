export const EXPENSES_MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS expenses_claims (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  claimant_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  category TEXT NOT NULL CHECK (category IN ('travel', 'meals', 'equipment', 'other')),
  expense_date TEXT NOT NULL CHECK (length(expense_date) = 10),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  status TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  decision_comment TEXT CHECK (decision_comment IS NULL OR length(decision_comment) BETWEEN 1 AND 2000),
  created_at INTEGER NOT NULL,
  CHECK (
    (status IN ('draft', 'submitted') AND decision_comment IS NULL) OR
    (status IN ('approved', 'rejected') AND decision_comment IS NOT NULL)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS expenses_claims_tenant_claimant_date_idx
  ON expenses_claims (tenant_id, claimant_id, expense_date DESC, id);
CREATE INDEX IF NOT EXISTS expenses_claims_tenant_claimant_status_date_idx
  ON expenses_claims (tenant_id, claimant_id, status, expense_date DESC, id);
CREATE INDEX IF NOT EXISTS expenses_claims_tenant_status_date_idx
  ON expenses_claims (tenant_id, status, expense_date DESC, id);
`;
