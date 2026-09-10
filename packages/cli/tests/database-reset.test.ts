import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	databaseProviderConfigFromEnvironment,
	type DatabaseHandle,
} from '@flowdular/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArguments } from '../src/arguments.ts';
import { createCliDatabaseProvider } from '../src/database.ts';
import { runCommand } from '../src/runner.ts';

let workspace: string;
const environment = { ...process.env };

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'flowdular-database-reset-'));
	await writeFile(
		join(workspace, 'flowdular.json'),
		'{"modules":{"enabled":["profile.core","system.core"]}}\n',
	);
	delete process.env.FD_DATABASE_URL;
	process.env.NODE_ENV = 'development';
	process.env.FD_DATABASE_ADAPTER = 'pglite';
	process.env.FD_DATABASE_PGLITE_DIRECTORY = join(workspace, 'pglite');
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) {
		if (!(key in environment)) delete process.env[key];
	}
	Object.assign(process.env, environment);
});

async function withDatabase<T>(
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

async function seedProfileTable(): Promise<void> {
	await withDatabase(async (database) => {
		await database.executeScript(
			'CREATE TABLE profile_records (id TEXT PRIMARY KEY);',
		);
		await database.execute({
			text: 'INSERT INTO profile_records (id) VALUES ($1)',
			parameters: ['one'],
		});
	});
}

async function tableCount(): Promise<number> {
	return withDatabase(async (database) => {
		const result = await database.query<{ total: number | string }>({
			text: `SELECT count(*) AS total FROM pg_tables
			       WHERE schemaname = current_schema()`,
		});
		return Number(result.rows[0]?.total ?? 0);
	});
}

async function run(...arguments_: string[]) {
	return runCommand(
		parseArguments(['--root', workspace, 'database', 'reset', ...arguments_]),
	);
}

describe('database reset', () => {
	it('plans without dropping anything', async () => {
		await seedProfileTable();

		const result = await run();

		expect(result.ok).toBe(true);
		const data = (result as { data: Record<string, unknown> }).data;
		expect(data.adapter).toBe('pglite');
		expect(data.applied).toBe(false);
		expect(data.namespaces).toEqual([
			{ namespace: 'profile.core', tables: ['profile_records'] },
		]);
		await expect(tableCount()).resolves.toBe(1);
	});

	it('refuses to apply without the confirmation token', async () => {
		await seedProfileTable();

		const result = await run('--apply');

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'CONFIRMATION_REQUIRED' },
		});
	});

	it('drops every table once the confirmation token is given', async () => {
		await seedProfileTable();

		const result = await run('--apply', '--confirm', 'reset-database');

		expect(result).toMatchObject({ ok: true });
		expect(
			(result as { data: { droppedTables: number } }).data.droppedTables,
		).toBe(1);
		await expect(tableCount()).resolves.toBe(0);
	});

	/* One database holds every namespace, so a per-module reset would drop far
	   more than the flag promises. */
	it('refuses a module scope', async () => {
		await expect(run('--module', 'profile.core')).resolves.toMatchObject({
			ok: false,
			error: { code: 'SCOPE_UNSUPPORTED' },
		});
	});

	it('rejects a module that this workspace has not enabled', async () => {
		await expect(run('--module', 'catalog.core')).resolves.toMatchObject({
			ok: false,
			error: { code: 'MODULE_NOT_ENABLED' },
		});
	});
});
