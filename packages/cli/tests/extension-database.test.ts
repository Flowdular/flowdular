import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseProvider } from '@flowdular/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArguments } from '../src/arguments.ts';
import { runCommand } from '../src/runner.ts';

let workspace: string;
const environment = { ...process.env };

const CATALOG = {
	protocolVersion: 1,
	moduleId: 'probe.core',
	commands: [
		{
			path: ['probe', 'quiet'],
			capability: {
				id: 'probe.quiet',
				version: 1,
				summary: 'Answer without reading the database.',
				risk: 'read',
				requiresApprovedSpec: false,
				supportsDryRun: false,
			},
		},
		{
			path: ['probe', 'read'],
			capability: {
				id: 'probe.read',
				version: 1,
				summary: 'Read the configured database.',
				risk: 'read',
				requiresApprovedSpec: false,
				supportsDryRun: false,
			},
		},
		{
			path: ['probe', 'throw'],
			capability: {
				id: 'probe.throw',
				version: 1,
				summary: 'Fail on purpose.',
				risk: 'read',
				requiresApprovedSpec: false,
				supportsDryRun: false,
			},
		},
	],
};

/* The fixture lives outside the workspace and resolves no packages, so it
   freezes a plain object instead of calling defineCliExtension. */
const ENTRY = `const capabilities = ${JSON.stringify(
	Object.fromEntries(
		CATALOG.commands.map((command) => [
			command.capability.id,
			command.capability,
		]),
	),
	null,
	'\t',
)};

export default Object.freeze({
	protocolVersion: 1,
	moduleId: 'probe.core',
	commands: [
		{
			path: ['probe', 'quiet'],
			capability: capabilities['probe.quiet'],
			execute: () => ({ data: { read: false } }),
		},
		{
			path: ['probe', 'read'],
			capability: capabilities['probe.read'],
			execute: async (context) => {
				const databases = context.databases;
				if (!databases) throw new Error('no provider on the context');
				const lease = await databases.acquire({
					namespace: 'probe.core',
					purpose: 'migration',
				});
				try {
					const result = await lease.database.query({
						text: 'SELECT 1 AS answer',
					});
					return { data: { answer: Number(result.rows[0].answer), databases } };
				} finally {
					await lease.release();
				}
			},
		},
		{
			path: ['probe', 'throw'],
			capability: capabilities['probe.throw'],
			execute: () => {
				throw new Error('the probe command refused.');
			},
		},
	],
});
`;

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'flowdular-extension-database-'));
	const moduleRoot = join(workspace, 'modules/probe');
	await mkdir(join(moduleRoot, 'src/cli'), { recursive: true });
	await Promise.all([
		writeFile(
			join(workspace, 'flowdular.json'),
			'{"modules":{"enabled":["probe.core"]}}\n',
		),
		writeFile(
			join(moduleRoot, 'module.json'),
			`${JSON.stringify(
				{
					schemaVersion: 1,
					id: 'probe.core',
					package: '@flowdular/module-probe',
					version: '0.1.0',
					profile: 'full',
					capabilities: ['cli'],
					dependencies: [],
					tenancy: 'required',
					locales: ['en'],
					stability: 'experimental',
					cli: { catalog: 'src/cli/commands.json', entry: 'src/cli/index.ts' },
				},
				null,
				'\t',
			)}\n`,
		),
		writeFile(
			join(moduleRoot, 'src/cli/commands.json'),
			`${JSON.stringify(CATALOG, null, '\t')}\n`,
		),
		writeFile(join(moduleRoot, 'src/cli/index.ts'), ENTRY),
	]);
	process.env.NODE_ENV = 'development';
	process.env.FD_DATABASE_ADAPTER = 'pglite';
	process.env.FD_DATABASE_PGLITE_DIRECTORY = join(workspace, 'pglite');
	delete process.env.FD_DATABASE_URL;
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) {
		if (!(key in environment)) delete process.env[key];
	}
	Object.assign(process.env, environment);
});

async function run(...path: string[]) {
	return runCommand(parseArguments(['--root', workspace, ...path]));
}

describe('module CLI extension database', () => {
	it('hands a working provider to a command that asks for one', async () => {
		const result = await run('probe', 'read');

		expect(result.ok).toBe(true);
		expect((result.data as { answer: number }).answer).toBe(1);
	});

	/* The runner owns the provider for the length of the command. An extension
	   that kept the handle must not be able to reach the database afterwards. */
	it('disposes the provider once the command returns', async () => {
		const result = await run('probe', 'read');
		const { databases } = result.data as { databases: DatabaseProvider };

		await expect(
			databases.acquire({ namespace: 'probe.core', purpose: 'migration' }),
		).rejects.toMatchObject({ code: 'ADAPTER_DISPOSED' });
	});

	/* Proved by a configuration that cannot build a provider: the command only
	   succeeds because nothing ever read context.databases. */
	it('builds no provider for a command that never reads one', async () => {
		process.env.FD_DATABASE_ADAPTER = 'postgresql';
		delete process.env.FD_DATABASE_URL;

		const quiet = await run('probe', 'quiet');
		const reading = await run('probe', 'read');

		expect(quiet.ok).toBe(true);
		expect(reading.ok).toBe(false);
		expect(reading.error?.message).toContain('FD_DATABASE_URL');
	});

	it('reports a failing module command as an envelope, not a crash', async () => {
		const result = await run('probe', 'throw');

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'COMMAND_FAILED', message: 'the probe command refused.' },
		});
	});
});
