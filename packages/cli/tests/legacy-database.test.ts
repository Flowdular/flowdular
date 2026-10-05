import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { databaseProviderConfigFromEnvironment } from '@flowdular/database';
import { parseArguments } from '../src/arguments.ts';
import { createCliDatabaseProvider } from '../src/database.ts';
import { runCommand } from '../src/runner.ts';

let workspace: string;
const restore = new Map<string, string | undefined>();

/* A temporary embedded database, never the one the workspace runs on. */
beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), 'flowdular-legacy-database-'));
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

it('reports a pre-rename database as LEGACY_DATABASE', async () => {
	const databases = createCliDatabaseProvider(
		databaseProviderConfigFromEnvironment(process.env, workspace),
	);
	const lease = await databases.acquire({
		namespace: 'profile.core',
		purpose: 'migration',
	});
	try {
		await lease.database.executeScript(`CREATE TABLE _coreloom_migrations_v2 (
	namespace TEXT NOT NULL,
	id TEXT NOT NULL,
	PRIMARY KEY (namespace, id)
);`);
	} finally {
		await lease.release();
		await databases.dispose();
	}

	for (const command of [
		['migration', 'apply', '--module', 'profile.core', '--apply'],
		['migration', 'status', '--module', 'profile.core'],
	]) {
		const result = await runCommand(parseArguments(command));
		expect(result.ok, command.join(' ')).toBe(false);
		expect(result.error?.code, command.join(' ')).toBe('LEGACY_DATABASE');
	}
});
