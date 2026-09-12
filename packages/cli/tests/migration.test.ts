import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilityDescriptor } from '@flowdular/cli-protocol';
import {
	DATABASE_MIGRATION_LEDGER,
	databaseProviderConfigFromEnvironment,
	type DatabaseHandle,
} from '@flowdular/database';
import { parseArguments } from '../src/arguments.ts';
import { createCliDatabaseProvider } from '../src/database.ts';
import { runCommand } from '../src/runner.ts';

let workspace: string;
const restore = new Map<string, string | undefined>();

/* The embedded database is redirected into a temporary directory, so these
   tests never open the database the workspace runs on. It must be durable:
   every command opens the provider again and expects the previous command's
   ledger to still be there. */
beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), 'coreloom-migration-'));
	for (const key of [
		'NODE_ENV',
		'FD_DATABASE_ADAPTER',
		'FD_DATABASE_PGLITE_DIRECTORY',
	]) {
		restore.set(key, process.env[key]);
	}
	process.env.NODE_ENV = 'development';
	process.env.FD_DATABASE_ADAPTER = 'pglite';
	process.env.FD_DATABASE_PGLITE_DIRECTORY = join(workspace, 'pglite');
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

async function apply(moduleId: string, ...extra: string[]) {
	return runCommand(
		parseArguments(['migration', 'apply', '--module', moduleId, ...extra]),
	);
}

function actions(result: { data?: unknown }): readonly string[] {
	return (
		result.data as { migrations: readonly { action: string }[] }
	).migrations.map((migration) => migration.action);
}

/* A direct migration lease on the same database the commands use, so a test can
   damage the ledger the way an operator or a bad merge would. */
async function withMigrationDatabase<T>(
	run: (database: DatabaseHandle) => Promise<T>,
): Promise<T> {
	const databases = createCliDatabaseProvider(
		databaseProviderConfigFromEnvironment(process.env, workspace),
	);
	const lease = await databases.acquire({
		namespace: 'profile.core',
		purpose: 'migration',
	});
	try {
		return await run(lease.database);
	} finally {
		await lease.release();
		await databases.dispose();
	}
}

describe('migration status', () => {
	it('reports every migration as pending against an empty database', async () => {
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
			'access.core',
			'agents.core',
			'approvals.core',
			'audit.core',
			'auth.core',
			'automations.core',
			'connectors.core',
			'directory.core',
			'documents.core',
			'exports.core',
			'import.core',
			'metering.core',
			'notifications.core',
			'profile.core',
			'sandbox.core',
			'search.core',
			'workflows.core',
		]);
		expect(result.data.unmanaged).toEqual([]);
	});

	it('narrows to one module with --module', async () => {
		const result = await status('--module', 'profile.core');

		expect(result.data.modules).toHaveLength(1);
		expect(result.data.modules[0]?.moduleId).toBe('profile.core');
	});

	/* The largest module. Its migration list grows, so this pins the contract
	   the command owns, not the inventory a module happens to have today. */
	it('reports the agents module through the shared runner', async () => {
		const result = await status('--module', 'agents.core');
		const migrations = result.data.modules[0]?.migrations ?? [];

		expect(result.ok).toBe(true);
		expect(result.data.modules[0]?.moduleId).toBe('agents.core');
		expect(migrations[0]?.id).toBe('0001_agents_core');
		expect(new Set(migrations.map((migration) => migration.id)).size).toBe(
			migrations.length,
		);
		expect(migrations.every((migration) => migration.state === 'pending')).toBe(
			true,
		);
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
		const result = await apply('profile.core');

		expect(result.ok).toBe(true);
		expect(result.warnings).toContain(
			'Dry run only. Pass --apply to write the ledger and run the SQL.',
		);
		expect(
			(await status('--module', 'profile.core')).data.modules[0]?.ledger,
		).toBe(0);
	});

	it('applies the module migrations with --apply', async () => {
		const result = await apply('profile.core', '--apply');

		expect(result.ok).toBe(true);
		expect(
			(result.data as { migrations: readonly { id: string }[] }).migrations,
		).toEqual([
			{
				id: '0001_profile_core',
				action: 'applied',
				checksum: expect.any(String),
			},
			{
				id: '0002_profile_language',
				action: 'applied',
				checksum: expect.any(String),
			},
		]);
		expect(
			(await status('--module', 'profile.core')).data.modules[0]?.ledger,
		).toBe(2);
	});

	/* A database that carries the schema but lost its ledger is what a
	   pre-ledger deployment looks like. Every migration must adopt instead of
	   running its DDL a second time. */
	it('adopts a database that already carries the schema', async () => {
		await apply('profile.core', '--apply');
		await withMigrationDatabase((database) =>
			database.execute({ text: `DROP TABLE ${DATABASE_MIGRATION_LEDGER}` }),
		);

		const before = await status('--module', 'profile.core');
		expect(
			before.data.modules[0]?.migrations.map((migration) => migration.state),
		).toEqual(['adopted', 'adopted']);

		expect(actions(await apply('profile.core', '--apply'))).toEqual([
			'adopted',
			'adopted',
		]);
	});

	it('refuses to run outside development or test', async () => {
		const previous = process.env.FD_ENV;
		process.env.FD_ENV = 'production';
		try {
			const result = await apply('profile.core', '--apply');

			expect(result.ok).toBe(false);
			expect(result.error?.code).toBe('LOCAL_ONLY_CAPABILITY');
		} finally {
			if (previous === undefined) delete process.env.FD_ENV;
			else process.env.FD_ENV = previous;
		}
	});
});

describe('migration verify', () => {
	it('accepts a ledger that matches the workspace migrations', async () => {
		await apply('profile.core', '--apply');

		const result = await runCommand(parseArguments(['migration', 'verify']));

		expect(result.error).toBeUndefined();
		expect(
			(
				result.data as {
					modules: readonly { moduleId: string; recorded: number }[];
				}
			).modules.find((module) => module.moduleId === 'profile.core')?.recorded,
		).toBe(2);
	});

	it('reports a ledger row whose checksum drifted', async () => {
		await apply('profile.core', '--apply');
		await withMigrationDatabase((database) =>
			database.execute({
				text: `UPDATE ${DATABASE_MIGRATION_LEDGER}
				       SET checksum = 'sha256:edited'
				       WHERE namespace = $1 AND id = $2`,
				parameters: ['profile.core', '0001_profile_core'],
			}),
		);

		const result = await runCommand(parseArguments(['migration', 'verify']));

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe('MIGRATION_LEDGER_INVALID');
		expect(
			(
				result.error?.details as {
					modules: readonly { moduleId: string; mismatched: string[] }[];
				}
			).modules.find((module) => module.moduleId === 'profile.core')
				?.mismatched,
		).toEqual(['0001_profile_core']);
		expect((await status('--module', 'profile.core')).ok).toBe(false);
	});
});

describe('migration capabilities', () => {
	it('publishes the four descriptors the policy documents', async () => {
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
			'migration.scaffold:workspace-write:false',
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
