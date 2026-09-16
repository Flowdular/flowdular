import type { DatabaseMigration } from '@flowdular/database';
import {
	migrationObjectState,
	postgresTenantTableState,
} from '@flowdular/database';

/* Mirrors migrations/0001_documents_core.up.sql byte for byte;
   tests/migrations.test.ts fails on drift. */
export const DOCUMENTS_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS documents_files (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_module TEXT NOT NULL,
  record_ref TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes BIGINT NOT NULL CHECK (bytes >= 0),
  checksum TEXT,
  storage_key TEXT NOT NULL,
  uploader_account_id TEXT NOT NULL,
  scan TEXT NOT NULL CHECK (scan IN ('unscanned', 'clean', 'infected')),
  status TEXT NOT NULL CHECK (status IN ('stored', 'deleted')),
  description TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_files_tenant_created_idx
  ON documents_files (tenant_id, created_at DESC, id);
-- The owning module and its record reference are how another module reaches its
-- attachments, so the pair leads the index the capability reads.
CREATE INDEX IF NOT EXISTS documents_files_record_idx
  ON documents_files (tenant_id, owner_module, record_ref, created_at DESC, id);
-- One row per object. A second row on one key would double count the quota and
-- leave the delete order pointing at bytes another row still claims.
CREATE UNIQUE INDEX IF NOT EXISTS documents_files_storage_key_idx
  ON documents_files (tenant_id, storage_key);
-- The workspace quota is the sum of what is still stored, so the aggregate
-- reads this partial index instead of walking the workspace's rows.
CREATE INDEX IF NOT EXISTS documents_files_usage_idx
  ON documents_files (tenant_id, bytes) WHERE status = 'stored';
ALTER TABLE documents_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents_files FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_files_tenant_policy ON documents_files
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0002_documents_files_page.up.sql byte for byte. */
export const DOCUMENTS_MIGRATION_002 = `-- A page of documents is keyed on (created_at, id) in one direction, so the
-- index carries both columns descending. The index shipped with 0001 orders id
-- ascending under a descending created_at, which no scan direction turns into
-- the order a keyset page walks.
CREATE INDEX IF NOT EXISTS documents_files_page_idx
  ON documents_files (tenant_id, created_at DESC, id DESC);
`;

/* Mirrors migrations/0003_documents_rotation_inventory.up.sql byte for byte. */
export const DOCUMENTS_MIGRATION_003 = `-- The storage key rotation has to find the workspaces that still hold objects
-- before it knows which objects those are, so the cross-tenant role may count
-- stored rows by workspace and nothing else: the storage key, the record and
-- the file name stay invisible to it, and every object it names is read again
-- under the workspace that row named. PostgreSQL checks column privileges in
-- WHERE too, so \`status\` is part of the grant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY documents_files_background_policy ON documents_files
  FOR SELECT TO coreloom_background
  USING (status = 'stored');
REVOKE SELECT ON documents_files FROM coreloom_background;
GRANT SELECT (tenant_id, status) ON documents_files TO coreloom_background;
`;

/* Mirrors migrations/0004_documents_text.up.sql byte for byte. */
export const DOCUMENTS_MIGRATION_004 = `-- The text read out of a stored document, one row per workspace and document.
-- A pending row is the job the text runner claims; every other status is the
-- settled answer a later read returns without parsing again.
CREATE TABLE IF NOT EXISTS documents_text (
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'unscanned', 'unsupported', 'too-large')),
  reason TEXT,
  text TEXT NOT NULL DEFAULT '',
  pages INTEGER NOT NULL DEFAULT 0 CHECK (pages >= 0),
  truncated BOOLEAN NOT NULL DEFAULT false,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  requested_at BIGINT NOT NULL,
  claimed_by TEXT,
  claimed_at BIGINT,
  extracted_at BIGINT,
  PRIMARY KEY (tenant_id, document_id)
);
-- A document without a row copies a settled row of the same bytes.
CREATE INDEX IF NOT EXISTS documents_text_checksum_idx
  ON documents_text (tenant_id, content_sha256) WHERE status <> 'pending';
-- The runner's routing read walks pending rows in request order.
CREATE INDEX IF NOT EXISTS documents_text_pending_idx
  ON documents_text (requested_at, tenant_id, document_id) WHERE status = 'pending';
ALTER TABLE documents_text ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents_text FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_text_tenant_policy ON documents_text
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
-- The runner finds pending work across workspaces before it knows whose it is,
-- so the cross-tenant role reads the routing columns of pending rows and
-- nothing else; every claim and write runs again under the workspace named.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY documents_text_background_policy ON documents_text
  FOR SELECT TO coreloom_background
  USING (status = 'pending');
REVOKE SELECT ON documents_text FROM coreloom_background;
GRANT SELECT (tenant_id, document_id, status, requested_at) ON documents_text TO coreloom_background;
`;

/* Mirrors migrations/0005_documents_templates.up.sql byte for byte. */
export const DOCUMENTS_MIGRATION_005 = `-- Templates a module registers are defaults in code. A workspace gains a row
-- here once it renders or edits one, naming the current of its immutable
-- versions below.
CREATE TABLE IF NOT EXISTS document_templates (
  tenant_id TEXT NOT NULL,
  template_key TEXT NOT NULL CHECK (length(template_key) BETWEEN 3 AND 128),
  owner_module TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  updated_by TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, template_key)
);
CREATE TABLE IF NOT EXISTS document_template_versions (
  tenant_id TEXT NOT NULL,
  template_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  origin TEXT NOT NULL CHECK (origin IN ('module', 'edit', 'revert')),
  body TEXT NOT NULL CHECK (length(body) <= 65536),
  layout TEXT NOT NULL,
  input_schema TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('en', 'pl')),
  format TEXT NOT NULL CHECK (format IN ('pdf', 'docx')),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, template_key, version)
);
-- A render is the job that produces one document. The input is kept only until
-- the render settles.
CREATE TABLE IF NOT EXISTS document_renders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  template_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  owner_module TEXT NOT NULL,
  record_ref TEXT NOT NULL,
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  input TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL CHECK (format IN ('pdf', 'docx')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  document_id TEXT,
  error_code TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  requested_by TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at BIGINT,
  created_at BIGINT NOT NULL,
  finished_at BIGINT
);
-- A retried tool call carries the key its caller derived for that call, and
-- the key answers the render it first reached, even after the template gained
-- a version; the request digest refuses a key reused for another request.
CREATE TABLE IF NOT EXISTS document_render_keys (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  render_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS document_render_keys_render_idx
  ON document_render_keys (tenant_id, render_id);
-- The render tuple is the key ledger: the same version, record, format and
-- input answer the render that already exists.
CREATE UNIQUE INDEX IF NOT EXISTS document_renders_tuple_idx
  ON document_renders (tenant_id, template_key, version, owner_module, record_ref, format, input_digest);
-- The runner's routing read walks queued and running renders in request order.
CREATE INDEX IF NOT EXISTS document_renders_pending_idx
  ON document_renders (created_at, tenant_id, id) WHERE status IN ('queued', 'running');
-- The retention sweep removes settled renders of one workspace by age.
CREATE INDEX IF NOT EXISTS document_renders_settled_idx
  ON document_renders (tenant_id, created_at, id) WHERE status IN ('succeeded', 'failed');
ALTER TABLE document_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY document_templates_tenant_policy ON document_templates
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE document_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_template_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY document_template_versions_tenant_policy ON document_template_versions
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE document_renders ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_renders FORCE ROW LEVEL SECURITY;
CREATE POLICY document_renders_tenant_policy ON document_renders
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE document_render_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_render_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY document_render_keys_tenant_policy ON document_render_keys
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
-- The runner finds renders across workspaces before it knows whose they are,
-- so the cross-tenant role reads the routing columns of queued and running
-- renders and nothing else; every claim and write runs under the workspace.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY document_renders_background_policy ON document_renders
  FOR SELECT TO coreloom_background
  USING (status IN ('queued', 'running'));
REVOKE SELECT ON document_renders FROM coreloom_background;
GRANT SELECT (id, tenant_id, status, created_at, claimed_at) ON document_renders TO coreloom_background;
`;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_documents_core',
		sql: { postgresql: DOCUMENTS_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'documents_files',
				'documents_files_tenant_policy',
				[
					() => database.schema.hasIndex('documents_files_tenant_created_idx'),
					() => database.schema.hasIndex('documents_files_record_idx'),
					() => database.schema.hasIndex('documents_files_storage_key_idx'),
					() => database.schema.hasIndex('documents_files_usage_idx'),
				],
			),
	},
	{
		id: '0002_documents_files_page',
		sql: { postgresql: DOCUMENTS_MIGRATION_002 },
		/* The table is 0001's; this migration owns one index, so a database that
		   already carries it is adopted and one that does not runs it. */
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasIndex('documents_files_page_idx'),
			]),
	},
	{
		id: '0003_documents_rotation_inventory',
		sql: { postgresql: DOCUMENTS_MIGRATION_003 },
		/* A policy and a column grant leave no schema object behind, so the
		   privilege itself is what proves this migration ran. */
		inspectExisting: async (database) => {
			const result = await database.query<{ granted: boolean }>({
				text: `SELECT CASE WHEN to_regclass('documents_files') IS NOT NULL THEN
				  has_column_privilege('coreloom_background', 'documents_files', 'status', 'SELECT')
				ELSE false END AS granted`,
			});
			return result.rows[0]?.granted === true ? 'complete' : 'absent';
		},
	},
	{
		id: '0004_documents_text',
		sql: { postgresql: DOCUMENTS_MIGRATION_004 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'documents_text',
				'documents_text_tenant_policy',
				[
					() => database.schema.hasIndex('documents_text_checksum_idx'),
					() => database.schema.hasIndex('documents_text_pending_idx'),
					async () => {
						const result = await database.query<{ granted: boolean }>({
							text: `SELECT CASE WHEN to_regclass('documents_text') IS NOT NULL THEN
							  has_column_privilege('coreloom_background', 'documents_text', 'requested_at', 'SELECT')
							ELSE false END AS granted`,
						});
						return result.rows[0]?.granted === true;
					},
				],
			),
	},
	{
		id: '0005_documents_templates',
		sql: { postgresql: DOCUMENTS_MIGRATION_005 },
		inspectExisting: async (database) => {
			const states = [
				await postgresTenantTableState(
					database,
					'document_templates',
					'document_templates_tenant_policy',
				),
				await postgresTenantTableState(
					database,
					'document_template_versions',
					'document_template_versions_tenant_policy',
				),
				await postgresTenantTableState(
					database,
					'document_render_keys',
					'document_render_keys_tenant_policy',
					[() => database.schema.hasIndex('document_render_keys_render_idx')],
				),
				await postgresTenantTableState(
					database,
					'document_renders',
					'document_renders_tenant_policy',
					[
						() => database.schema.hasIndex('document_renders_tuple_idx'),
						() => database.schema.hasIndex('document_renders_pending_idx'),
						() => database.schema.hasIndex('document_renders_settled_idx'),
						async () => {
							const result = await database.query<{ granted: boolean }>({
								text: `SELECT CASE WHEN to_regclass('document_renders') IS NOT NULL THEN
								  has_column_privilege('coreloom_background', 'document_renders', 'claimed_at', 'SELECT')
								ELSE false END AS granted`,
							});
							return result.rows[0]?.granted === true;
						},
					],
				),
			];
			if (states.every((state) => state === 'complete')) return 'complete';
			if (states.every((state) => state === 'absent')) return 'absent';
			return 'partial';
		},
	},
];
