import type { ModuleMigration } from '@coreloom/kernel';

/* Every constant mirrors its migrations/<id>.up.sql file byte for byte;
   tests/migrations.test.ts fails on drift. */

export const EXPENSES_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS expenses_claims (
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

export const EXPENSES_MIGRATION_002_HISTORY = `CREATE TABLE IF NOT EXISTS expenses_claims_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 32),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  actor_label TEXT NOT NULL CHECK (length(actor_label) BETWEEN 1 AND 160),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 128),
  changes_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS expenses_claims_history_tenant_record_version_idx
  ON expenses_claims_history (tenant_id, record_id, version DESC);
`;

export const EXPENSES_MIGRATION_003_NOTE_TEMPLATE = `ALTER TABLE expenses_claims
  ADD COLUMN note_template TEXT CHECK (note_template IS NULL OR length(note_template) BETWEEN 1 AND 2000);
`;

export const migrations: readonly ModuleMigration[] = [
	{ id: '0001_expenses_core', statements: EXPENSES_MIGRATION_001 },
	{ id: '0002_expenses_history', statements: EXPENSES_MIGRATION_002_HISTORY },
	{
		id: '0003_expenses_note_template',
		statements: EXPENSES_MIGRATION_003_NOTE_TEMPLATE,
	},
];
