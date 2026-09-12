import type { DatabaseMigration } from '@flowdular/database';
import { postgresTenantTableState } from '@flowdular/database';

/** Every tenant table the module owns, in creation order. */
export const DIRECTORY_TENANT_TABLES = [
	'directory_scim_tokens',
	'directory_scim_users',
	'directory_scim_groups',
	'directory_scim_group_members',
	'directory_provisioning_events',
] as const;

/* Mirrors migrations/0001_directory_core.up.sql byte for byte. */
export const DIRECTORY_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS directory_scim_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  token_fingerprint TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  expires_at BIGINT,
  revoked_at BIGINT
);
-- Case folded like the group name below: two labels an owner cannot tell apart
-- in the list must not be two credentials.
CREATE UNIQUE INDEX IF NOT EXISTS directory_scim_tokens_label_idx
  ON directory_scim_tokens (tenant_id, lower(label));
-- Authentication reads one row by this derived prefix and then compares the
-- full hash in constant time, so an unknown credential costs the same lookup.
CREATE UNIQUE INDEX IF NOT EXISTS directory_scim_tokens_fingerprint_idx
  ON directory_scim_tokens (tenant_id, token_fingerprint);
ALTER TABLE directory_scim_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_scim_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_scim_tokens_tenant_policy ON directory_scim_tokens
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS directory_scim_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  external_id TEXT,
  user_name TEXT NOT NULL,
  account_id TEXT NOT NULL,
  active SMALLINT NOT NULL CHECK (active IN (0, 1)),
  created_at BIGINT NOT NULL,
  last_synced_at BIGINT NOT NULL
);
-- One provider identity per workspace, and one mapping per account: both are
-- what makes a repeated create idempotent instead of a second membership.
CREATE UNIQUE INDEX IF NOT EXISTS directory_scim_users_user_name_idx
  ON directory_scim_users (tenant_id, user_name);
CREATE UNIQUE INDEX IF NOT EXISTS directory_scim_users_account_idx
  ON directory_scim_users (tenant_id, account_id);
CREATE INDEX IF NOT EXISTS directory_scim_users_external_idx
  ON directory_scim_users (tenant_id, external_id);
ALTER TABLE directory_scim_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_scim_users FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_scim_users_tenant_policy ON directory_scim_users
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS directory_scim_groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  external_id TEXT,
  display_name TEXT NOT NULL,
  role_key TEXT,
  precedence INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
-- displayName is a caseExact=false attribute, so the uniqueness the provider
-- sees and the index that enforces it have to fold case the same way.
CREATE UNIQUE INDEX IF NOT EXISTS directory_scim_groups_display_name_idx
  ON directory_scim_groups (tenant_id, lower(display_name));
-- Role resolution walks the mapped groups of one user in precedence order.
CREATE INDEX IF NOT EXISTS directory_scim_groups_precedence_idx
  ON directory_scim_groups (tenant_id, precedence, id);
ALTER TABLE directory_scim_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_scim_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_scim_groups_tenant_policy ON directory_scim_groups
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS directory_scim_group_members (
  tenant_id TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES directory_scim_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES directory_scim_users(id) ON DELETE CASCADE,
  added_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, group_id, user_id)
);
CREATE INDEX IF NOT EXISTS directory_scim_group_members_user_idx
  ON directory_scim_group_members (tenant_id, user_id);
ALTER TABLE directory_scim_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_scim_group_members FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_scim_group_members_tenant_policy ON directory_scim_group_members
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- Evidence outlives the credential, so the token id is recorded without a
-- foreign key: revoking or pruning a token never removes its trail.
CREATE TABLE IF NOT EXISTS directory_provisioning_events (
  id TEXT PRIMARY KEY,
  -- Two operations of one request land in the same millisecond, so the order
  -- the log is read in comes from storage rather than from the clock.
  sequence BIGINT GENERATED BY DEFAULT AS IDENTITY,
  tenant_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('user-create', 'user-update', 'user-deactivate', 'user-reactivate', 'group-create', 'group-update', 'group-delete', 'membership-change')),
  subject TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'unchanged', 'refused')),
  reason TEXT,
  occurred_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS directory_provisioning_events_time_idx
  ON directory_provisioning_events (tenant_id, occurred_at DESC, sequence DESC);
ALTER TABLE directory_provisioning_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_provisioning_events FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_provisioning_events_tenant_policy ON directory_provisioning_events
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_directory_core',
		sql: { postgresql: DIRECTORY_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'directory_scim_tokens',
				'directory_scim_tokens_tenant_policy',
				[
					() => database.schema.hasTable('directory_scim_users'),
					() => database.schema.hasTable('directory_scim_groups'),
					() => database.schema.hasTable('directory_scim_group_members'),
					() => database.schema.hasTable('directory_provisioning_events'),
					() =>
						database.schema.hasIndex('directory_scim_tokens_fingerprint_idx'),
				],
			),
	},
];
