import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilityDescriptor } from '@coreloom/cli-protocol';
import { parseArguments } from '../src/arguments.ts';
import { runCommand } from '../src/runner.ts';

const modules = [
	'agents',
	'auth',
	'automations',
	'catalog',
	'expenses',
	'parties',
	'profile',
	'sandbox',
	'workflows',
] as const;

let workspace: string;
const restore = new Map<string, string | undefined>();

/* Every module database is redirected into a temporary directory, so these
   tests never open the databases the workspace runs on. */
beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), 'coreloom-migration-'));
	for (const module of modules) {
		const key = `CL_${module.toUpperCase()}_DATABASE`;
		restore.set(key, process.env[key]);
		process.env[key] = join(workspace, `${module}.db`);
	}
});

afterEach(() => {
	for (const [key, value] of restore) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	restore.clear();
	rmSync(workspace, { recursive: true, force: true });
});

interface StatusData {
	readonly modules: readonly {
		readonly moduleId: string;
		readonly ledger: number;
		readonly migrations: readonly {
			readonly id: string;
			readonly state: string;
		}[];
	}[];
	readonly unmanaged: readonly { readonly moduleId: string }[];
	readonly summary: Record<string, number>;
}

async function status(...extra: string[]) {
	const result = await runCommand(
		parseArguments(['migration', 'status', ...extra]),
	);
	return {
		ok: result.ok,
		data: result.data as StatusData,
		error: result.error,
	};
}

function partiesPath(): string {
	return join(workspace, 'parties.db');
}

describe('migration status', () => {
	it('reports every migration as pending while no database exists', async () => {
		const result = await status();

		expect(result.ok).toBe(true);
		const pending = result.data.modules.reduce(
			(total, module) => total + module.migrations.length,
			0,
		);
		expect(result.data.summary).toEqual({
			applied: 0,
			adopted: 0,
			pending,
			mismatch: 0,
		});
		expect(result.data.modules.map((module) => module.moduleId)).toEqual([
			'agents.core',
			'auth.core',
			'automations.core',
			'catalog.core',
			'expenses.core',
			'parties.core',
			'profile.core',
			'sandbox.core',
			'workflows.core',
		]);
	});

	it('reports no unmanaged module after every repository adopted the runner', async () => {
		const result = await status();

		expect(result.data.unmanaged).toEqual([]);
	});

	it('narrows to one module with --module', async () => {
		const result = await status('--module', 'parties.core');

		expect(result.data.modules).toHaveLength(1);
		expect(result.data.modules[0]?.moduleId).toBe('parties.core');
	});

	it('reports the agents module through the shared runner', async () => {
		const result = await status('--module', 'agents.core');

		expect(result.ok).toBe(true);
		expect(result.data.modules[0]?.moduleId).toBe('agents.core');
		expect(
			result.data.modules[0]?.migrations.map((migration) => migration.id),
		).toEqual([
			'0001_agents_core',
			'0002_provider_connections',
			'0003_resource_audit',
			'0004_run_grants',
			'0005_long_running_limits',
			'0006_agent_skills',
			'0007_model_readiness',
			'0008_output_limits',
			'0009_agent_audit_v3',
			'0012_agent_run_costs',
			'0013_workflow_prerequisites',
			'0014_agent_action_audit',
			'0015_agent_run_actors',
			'0016_module_owned_agents',
			'0017_agent_authorization_subjects',
		]);
		expect(
			result.data.modules[0]?.migrations.every(
				(migration) => migration.state === 'pending',
			),
		).toBe(true);
	});
});

describe('migration apply', () => {
	it('needs an explicit module', async () => {
		const result = await runCommand(
			parseArguments(['migration', 'apply', '--apply']),
		);

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe('INPUT_REQUIRED');
	});

	it('writes nothing without --apply', async () => {
		const result = await runCommand(
			parseArguments(['migration', 'apply', '--module', 'parties.core']),
		);

		expect(result.ok).toBe(true);
		expect(result.warnings).toContain(
			'Dry run only. Pass --apply to write the ledger and run the SQL.',
		);
		expect(existsSync(partiesPath())).toBe(false);
	});

	it('applies the module migrations with --apply', async () => {
		const result = await runCommand(
			parseArguments([
				'migration',
				'apply',
				'--module',
				'parties.core',
				'--apply',
			]),
		);

		expect(result.ok).toBe(true);
		expect(
			(result.data as { migrations: readonly { action: string }[] }).migrations,
		).toEqual([
			{
				id: '0001_parties_core',
				action: 'applied',
				checksum: expect.any(String),
			},
			{
				id: '0002_parties_vat_id',
				action: 'applied',
				checksum: expect.any(String),
			},
			{
				id: '0003_parties_history',
				action: 'applied',
				checksum: expect.any(String),
			},
			{
				id: '0004_parties_history_service_actors',
				action: 'applied',
				checksum: expect.any(String),
			},
			{
				id: '0005_parties_idempotency_ledger',
				action: 'applied',
				checksum: expect.any(String),
			},
		]);
		expect(
			(await status('--module', 'parties.core')).data.modules[0]?.ledger,
		).toBe(5);
	});

	it('adopts a database that already carries the schema and its rows', async () => {
		const database = new DatabaseSync(partiesPath());
		database.exec(`CREATE TABLE parties (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX parties_tenant_name_idx ON parties (tenant_id, name, id);
ALTER TABLE parties ADD COLUMN vat_id TEXT;
CREATE TABLE parties_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  run_id TEXT,
  changes_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX parties_history_tenant_record_version_idx
  ON parties_history (tenant_id, record_id, version DESC);
CREATE TABLE parties_history_v2 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  run_id TEXT,
  configured_by_json TEXT,
  changes_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX parties_history_v2_tenant_record_version_idx
  ON parties_history_v2 (tenant_id, record_id, version DESC);
INSERT INTO parties (id, tenant_id, name, kind, email, phone, status, created_at, vat_id)
VALUES ('p1', 't1', 'Contoso GmbH', 'customer', NULL, NULL, 'active', 1, 'DE811569869');`);
		database.close();

		const before = await status('--module', 'parties.core');
		expect(
			before.data.modules[0]?.migrations.map((migration) => migration.state),
		).toEqual(['adopted', 'adopted', 'adopted', 'adopted', 'pending']);

		const result = await runCommand(
			parseArguments([
				'migration',
				'apply',
				'--module',
				'parties.core',
				'--apply',
			]),
		);
		expect(
			(
				result.data as { migrations: readonly { action: string }[] }
			).migrations.map((migration) => migration.action),
		).toEqual(['adopted', 'adopted', 'adopted', 'adopted', 'applied']);

		const after = new DatabaseSync(partiesPath(), { readOnly: true });
		expect(after.prepare('SELECT name, vat_id FROM parties').all()).toEqual([
			{ name: 'Contoso GmbH', vat_id: 'DE811569869' },
		]);
		after.close();
	});

	it('refuses to run outside development or test', async () => {
		const previous = process.env.CL_ENV;
		process.env.CL_ENV = 'production';
		try {
			const result = await runCommand(
				parseArguments([
					'migration',
					'apply',
					'--module',
					'parties.core',
					'--apply',
				]),
			);

			expect(result.ok).toBe(false);
			expect(result.error?.code).toBe('LOCAL_ONLY_CAPABILITY');
		} finally {
			if (previous === undefined) delete process.env.CL_ENV;
			else process.env.CL_ENV = previous;
		}
	});
});

describe('migration verify', () => {
	it('accepts a ledger that matches the workspace migrations', async () => {
		await runCommand(
			parseArguments([
				'migration',
				'apply',
				'--module',
				'parties.core',
				'--apply',
			]),
		);

		const result = await runCommand(parseArguments(['migration', 'verify']));

		expect(result.ok).toBe(true);
		expect(
			(
				result.data as {
					modules: readonly { moduleId: string; recorded: number }[];
				}
			).modules.find((module) => module.moduleId === 'parties.core')?.recorded,
		).toBe(5);
	});

	it('reports a ledger row whose checksum drifted', async () => {
		await runCommand(
			parseArguments([
				'migration',
				'apply',
				'--module',
				'parties.core',
				'--apply',
			]),
		);
		const database = new DatabaseSync(partiesPath());
		database.exec(
			"UPDATE _coreloom_migrations SET checksum = 'sha256:edited' WHERE id = '0001_parties_core'",
		);
		database.close();

		const result = await runCommand(parseArguments(['migration', 'verify']));

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe('MIGRATION_LEDGER_INVALID');
		expect(
			(
				result.error?.details as {
					modules: readonly { moduleId: string; mismatched: string[] }[];
				}
			).modules.find((module) => module.moduleId === 'parties.core')
				?.mismatched,
		).toEqual(['0001_parties_core']);
		expect((await status('--module', 'parties.core')).ok).toBe(false);
	});
});

describe('migration capabilities', () => {
	it('publishes the three descriptors the policy documents', async () => {
		const result = await runCommand(parseArguments(['capability', 'list']));
		const listed = (
			result.data as { capabilities: readonly CapabilityDescriptor[] }
		).capabilities.filter((entry) => entry.id.startsWith('migration.'));

		expect(
			listed.map(
				(entry) => `${entry.id}:${entry.risk}:${entry.localOnly ?? false}`,
			),
		).toEqual([
			'migration.status:read:false',
			'migration.verify:read:false',
			'migration.apply.local:process:true',
		]);
	});

	it('runs migration.status through capability run', async () => {
		const result = await runCommand(
			parseArguments(['capability', 'run', 'migration.status']),
		);
		const data = result.data as StatusData;
		const pending = data.modules.reduce(
			(total, module) => total + module.migrations.length,
			0,
		);

		expect(result.ok).toBe(true);
		expect(data.summary.pending).toBe(pending);
	});
});
