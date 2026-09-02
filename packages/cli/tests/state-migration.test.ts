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
	workspace = await mkdtemp(join(tmpdir(), 'coreloom-state-migration-'));
	await writeFile(
		join(workspace, 'coreloom.json'),
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
			destination: '.coreloom/data',
			files: ['auth.db', 'agent-credential.key'],
			sourcePreserved: true,
		});
		await expect(
			readFile(join(workspace, '.octane-erp/auth.db'), 'utf8'),
		).resolves.toBe('database');
		await expect(
			readFile(join(workspace, '.coreloom/data/auth.db'), 'utf8'),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('requires the migration confirmation with --apply', async () => {
		await legacy('auth.db', 'database');

		const result = await run('--apply');

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe('CONFIRMATION_REQUIRED');
	});

	it('copies databases and vault keys without removing the source', async () => {
		await legacy('auth.db', 'database');
		await legacy('agent-credential.key', 'secret');

		const result = await run('--apply', '--confirm', 'migrate-legacy-state');

		expect(result.ok).toBe(true);
		expect(result.data).toMatchObject({ applied: true, sourcePreserved: true });
		await expect(
			readFile(join(workspace, '.coreloom/data/auth.db'), 'utf8'),
		).resolves.toBe('database');
		await expect(
			readFile(join(workspace, '.coreloom/data/agent-credential.key'), 'utf8'),
		).resolves.toBe('secret');
		await expect(
			readFile(join(workspace, '.octane-erp/auth.db'), 'utf8'),
		).resolves.toBe('database');
	});

	it('refuses a destination collision without changing either file', async () => {
		await legacy('auth.db', 'legacy');
		await mkdir(join(workspace, '.coreloom/data'), { recursive: true });
		await writeFile(join(workspace, '.coreloom/data/auth.db'), 'current');

		const result = await run('--apply', '--confirm', 'migrate-legacy-state');

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe('LEGACY_STATE_MIGRATION_REFUSED');
		await expect(
			readFile(join(workspace, '.coreloom/data/auth.db'), 'utf8'),
		).resolves.toBe('current');
		await expect(
			readFile(join(workspace, '.octane-erp/auth.db'), 'utf8'),
		).resolves.toBe('legacy');
	});

	it('refuses databases with WAL state and tells the operator to stop clients', async () => {
		await legacy('auth.db', 'database');
		await legacy('auth.db-wal', 'pending');

		const preview = await run();
		expect(preview.ok).toBe(true);
		expect(preview.data).toMatchObject({ ready: false });
		expect((preview.data as { blockers: string[] }).blockers[0]).toContain(
			'auth.db-wal',
		);

		const result = await run('--apply', '--confirm', 'migrate-legacy-state');
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe('LEGACY_STATE_MIGRATION_REFUSED');
	});

	it('refuses a stale destination sidecar even when the main target is absent', async () => {
		await legacy('auth.db', 'database');
		await mkdir(join(workspace, '.coreloom/data'), { recursive: true });
		await writeFile(join(workspace, '.coreloom/data/auth.db-wal'), 'stale');

		const result = await run('--apply', '--confirm', 'migrate-legacy-state');

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe('LEGACY_STATE_MIGRATION_REFUSED');
		await expect(
			readFile(join(workspace, '.coreloom/data/auth.db'), 'utf8'),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('refuses a linked legacy directory', async () => {
		const outside = await mkdtemp(join(tmpdir(), 'coreloom-state-source-'));
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
