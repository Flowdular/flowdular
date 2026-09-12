import {
	mkdtemp,
	mkdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArguments } from '../src/arguments.ts';
import { runCommand } from '../src/runner.ts';

let workspace: string;

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'flowdular-state-migration-'));
	await writeFile(
		join(workspace, 'flowdular.json'),
		'{"modules":{"enabled":[]}}\n',
	);
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
});

async function run(...arguments_: string[]) {
	return runCommand(
		parseArguments([
			'--root',
			workspace,
			'setup',
			'migrate-state',
			...arguments_,
		]),
	);
}

async function legacy(name: string, content: string) {
	await mkdir(join(workspace, '.octane-erp'), { recursive: true });
	await writeFile(join(workspace, '.octane-erp', name), content);
}

describe('local state identity migration', () => {
	it('is a dry run by default and reports the exact copy plan', async () => {
		await legacy('auth.db', 'database');
		await legacy('agent-credential.key', 'secret');

		const result = await run();

		expect(result.ok).toBe(true);
		expect(result.data).toMatchObject({
			applied: false,
			ready: true,
			source: '.octane-erp',
			destination: '.flowdular/data',
			files: ['agent-credential.key'],
			unsupported: ['auth.db'],
			sourcePreserved: true,
		});
		expect(result.warnings[0]).toContain('.octane-erp/auth.db');
		expect(result.warnings[0]).toContain('SQLite');
		await expect(
			readFile(join(workspace, '.octane-erp/auth.db'), 'utf8'),
		).resolves.toBe('database');
		await expect(
			readFile(join(workspace, '.flowdular/data/agent-credential.key'), 'utf8'),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('requires the migration confirmation with --apply', async () => {
		await legacy('agent-credential.key', 'secret');

		const result = await run('--apply');

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe('CONFIRMATION_REQUIRED');
	});

	it('copies vault keys, leaves SQLite databases in place and names each one', async () => {
		await legacy('auth.db', 'database');
		await legacy('catalog.db', 'database');
		await legacy('custom-module.db', 'database');
		await legacy('agent-credential.key', 'secret');

		const result = await run('--apply', '--confirm', 'migrate-legacy-state');

		expect(result.ok).toBe(true);
		expect(result.data).toMatchObject({
			applied: true,
			files: ['agent-credential.key'],
			unsupported: ['auth.db', 'catalog.db', 'custom-module.db'],
			sourcePreserved: true,
		});
		expect(result.warnings.slice(0, 3)).toEqual([
			expect.stringContaining('.octane-erp/auth.db is a SQLite database'),
			expect.stringContaining('.octane-erp/catalog.db is a SQLite database'),
			expect.stringContaining(
				'.octane-erp/custom-module.db is a SQLite database',
			),
		]);
		expect(result.warnings[0]).toContain('does not carry over');
		await expect(
			readFile(join(workspace, '.flowdular/data/agent-credential.key'), 'utf8'),
		).resolves.toBe('secret');
		await expect(
			readFile(join(workspace, '.flowdular/data/auth.db'), 'utf8'),
		).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(
			readFile(join(workspace, '.octane-erp/auth.db'), 'utf8'),
		).resolves.toBe('database');
		await expect(
			readFile(join(workspace, '.octane-erp/catalog.db'), 'utf8'),
		).resolves.toBe('database');
		await expect(
			readFile(join(workspace, '.octane-erp/custom-module.db'), 'utf8'),
		).resolves.toBe('database');
	});

	it('refuses a destination collision without changing either file', async () => {
		await legacy('agent-credential.key', 'legacy');
		await mkdir(join(workspace, '.flowdular/data'), { recursive: true });
		await writeFile(
			join(workspace, '.flowdular/data/agent-credential.key'),
			'current',
		);

		const result = await run('--apply', '--confirm', 'migrate-legacy-state');

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe('LEGACY_STATE_MIGRATION_REFUSED');
		await expect(
			readFile(join(workspace, '.flowdular/data/agent-credential.key'), 'utf8'),
		).resolves.toBe('current');
		await expect(
			readFile(join(workspace, '.octane-erp/agent-credential.key'), 'utf8'),
		).resolves.toBe('legacy');
	});

	it('refuses a linked legacy directory', async () => {
		const outside = await mkdtemp(join(tmpdir(), 'flowdular-state-source-'));
		try {
			await symlink(outside, join(workspace, '.octane-erp'));
			const result = await run('--apply', '--confirm', 'migrate-legacy-state');
			expect(result.ok).toBe(false);
			expect(result.error?.code).toBe('LEGACY_STATE_MIGRATION_REFUSED');
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});
