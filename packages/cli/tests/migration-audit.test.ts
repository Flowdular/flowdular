import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseMigration } from '@flowdular/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moduleMigrationAudit } from '../src/migration-audit.ts';

let moduleDirectory: string;

const SQL = `CREATE TABLE IF NOT EXISTS demo_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS demo_records_tenant_title_idx
  ON demo_records (tenant_id, title, id);
ALTER TABLE demo_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_records FORCE ROW LEVEL SECURITY;
CREATE POLICY demo_records_tenant_policy ON demo_records
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

beforeEach(async () => {
	moduleDirectory = await mkdtemp(join(tmpdir(), 'coreloom-migration-audit-'));
	await mkdir(join(moduleDirectory, 'migrations'), { recursive: true });
});

afterEach(async () => {
	await rm(moduleDirectory, { recursive: true, force: true });
});

async function write(id: string, sql: string): Promise<void> {
	await writeFile(join(moduleDirectory, 'migrations', `${id}.up.sql`), sql);
}

function declare(...ids: readonly string[]): readonly DatabaseMigration[] {
	return ids.map((id) => ({ id, sql: { postgresql: SQL } }));
}

async function issues(...declared: readonly string[]) {
	return (
		await moduleMigrationAudit(
			'demo.core',
			moduleDirectory,
			declare(...(declared.length > 0 ? declared : ['0001_demo_core'])),
		)
	).issues;
}

describe('migration script audit', () => {
	it('accepts a declared tenant table with forced row security', async () => {
		await write('0001_demo_core', SQL);
		await expect(issues()).resolves.toEqual([]);
	});

	it('reports a script no migration declares, so the ledger never runs it', async () => {
		await write('0001_demo_core', SQL);
		await write(
			'0002_demo_extra',
			'ALTER TABLE demo_records ADD COLUMN note TEXT;\n',
		);

		expect(await issues('0001_demo_core')).toMatchObject([
			{ migrationId: '0002_demo_extra', code: 'MIGRATION_NOT_DECLARED' },
		]);
	});

	it('reports a declared migration whose script was never committed', async () => {
		await write('0001_demo_core', SQL);

		expect(await issues('0001_demo_core', '0002_demo_extra')).toMatchObject([
			{ migrationId: '0002_demo_extra', code: 'MIGRATION_SCRIPT_MISSING' },
		]);
	});

	/* The check that matters most: a tenant table the runtime role could read
	   across tenants because the policy was forgotten. */
	it('refuses a tenant table without forced row security', async () => {
		await write(
			'0001_demo_core',
			SQL.replace('ALTER TABLE demo_records FORCE ROW LEVEL SECURITY;\n', ''),
		);

		expect(await issues()).toMatchObject([
			{
				code: 'ROW_SECURITY_MISSING',
				message:
					'Table "demo_records" needs ENABLE, FORCE and a tenant policy.',
			},
		]);
	});

	/* A rebuild drops the original and renames the replacement into its place.
	   The temporary table is gone by the end, so it needs no policy. */
	it('checks the tables a rebuild leaves behind, not the temporary one', async () => {
		await write(
			'0001_demo_core',
			SQL +
				`CREATE TABLE demo_records_v2 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  note TEXT
);
INSERT INTO demo_records_v2 (id, tenant_id, title, created_at, note)
  SELECT id, tenant_id, title, created_at, NULL FROM demo_records;
DROP TABLE demo_records;
ALTER TABLE demo_records_v2 RENAME TO demo_records;
ALTER TABLE demo_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_records FORCE ROW LEVEL SECURITY;
CREATE POLICY demo_records_tenant_policy ON demo_records
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`,
		);

		expect(
			(await issues()).filter((issue) => issue.code === 'ROW_SECURITY_MISSING'),
		).toEqual([]);
	});

	it('still refuses a rebuild that forgets the policy on the renamed table', async () => {
		await write(
			'0001_demo_core',
			SQL +
				`CREATE TABLE demo_records_v2 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
DROP TABLE demo_records;
ALTER TABLE demo_records_v2 RENAME TO demo_records;
`,
		);

		expect(
			(await issues()).some(
				(issue) =>
					issue.code === 'ROW_SECURITY_MISSING' &&
					issue.message.includes('demo_records'),
			),
		).toBe(true);
	});

	/* The cross-tenant role is a read boundary. A policy that widens it past
	   SELECT would let a scheduler act on a tenant it merely polled. */
	it('accepts a read-only background policy', async () => {
		await write(
			'0001_demo_core',
			SQL +
				`CREATE POLICY demo_records_background_policy ON demo_records
  FOR SELECT TO coreloom_background USING (true);
`,
		);

		await expect(issues()).resolves.toEqual([]);
	});

	it('refuses a background policy that is not restricted to SELECT', async () => {
		await write(
			'0001_demo_core',
			SQL +
				`CREATE POLICY demo_records_background_policy ON demo_records
  TO coreloom_background USING (true);
`,
		);

		expect(await issues()).toMatchObject([
			{ code: 'BACKGROUND_POLICY_TOO_WIDE' },
		]);
	});

	it('refuses a background policy that carries a write check', async () => {
		await write(
			'0001_demo_core',
			SQL +
				`CREATE POLICY demo_records_background_policy ON demo_records
  FOR SELECT TO coreloom_background USING (true) WITH CHECK (true);
`,
		);

		expect(
			(await issues()).some(
				(issue) => issue.code === 'BACKGROUND_POLICY_TOO_WIDE',
			),
		).toBe(true);
	});
});
