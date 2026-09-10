import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
	symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { success } from '@flowdular/cli-protocol';
import { parseArguments, type ParsedArguments } from '../src/arguments.ts';
import { runSetupWizard, type SetupPrompts } from '../src/setup-wizard.ts';
import { saveSetupEnvironment } from '../src/setup-environment.ts';

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-wizard-'));
	roots.push(root);
	await writeFile(join(root, 'flowdular.json'), '{}');
	await writeFile(
		join(root, '.env'),
		'# Keep this\nOTHER_SECRET=unchanged\nFD_DATABASE_ADAPTER=pglite\n',
	);
	for (const key of Object.keys(process.env))
		if (key.startsWith('FD_') || key.startsWith('CORELOOM_'))
			vi.stubEnv(key, undefined);
	vi.stubEnv('NODE_ENV', 'development');
	vi.stubEnv('FD_DATABASE_ADAPTER', 'pglite');
	const calls: ParsedArguments[] = [];
	const execute = async (args: ParsedArguments) => {
		calls.push(args);
		return success({ applied: args.flags.has('apply') });
	};
	const io: SetupPrompts = {
		choose: async () => 'local',
		confirm: async () => true,
		connection: async (message) =>
			`postgres://${message.split(' ')[0]!.toLowerCase()}:secret@localhost/app`,
	};
	return {
		root,
		args: parseArguments(['setup', '--root', root]),
		calls,
		execute,
		io,
	};
}

it('previews a local demo before explicit confirmation and invokes the existing guarded reset', async () => {
	const f = await fixture();
	f.io.confirm = async (message) => {
		expect(message).toContain('app is stopped');
		expect(f.calls.at(-1)?.flags.has('apply')).toBe(false);
		return true;
	};
	expect((await runSetupWizard(f.args, f.io, f.execute)).ok).toBe(true);
	expect(f.calls.map((call) => call.positionals)).toEqual([
		['setup', 'check'],
		['setup', 'quick'],
		['setup', 'quick'],
	]);
	expect(f.calls.at(-1)?.flags.get('confirm')).toBe('reset-local-auth');
	expect(f.calls.at(-1)?.flags.get('apply')).toBe(true);
});

it('declining or cancelling never applies a reset', async () => {
	const f = await fixture();
	f.io.confirm = async () => false;
	await runSetupWizard(f.args, f.io, f.execute);
	expect(f.calls.every((call) => !call.flags.has('apply'))).toBe(true);
	f.io.choose = async () => {
		throw Object.assign(new Error('cancelled'), { name: 'ExitPromptError' });
	};
	expect((await runSetupWizard(f.args, f.io, f.execute)).data).toEqual({
		cancelled: true,
	});
});

it('does not reset a custom embedded database', async () => {
	const f = await fixture();
	vi.stubEnv('FD_DATABASE_PGLITE_DIRECTORY', join(f.root, 'custom'));
	const result = await runSetupWizard(f.args, f.io, f.execute);
	expect(result.ok).toBe(false);
	expect(result.error?.code).toBe('LOCAL_DEMO_UNAVAILABLE');
	expect(f.calls).toHaveLength(1);
});

it('refuses local demo on a hosted database without touching it', async () => {
	const f = await fixture();
	vi.stubEnv('FD_DATABASE_ADAPTER', 'postgresql');
	vi.stubEnv('FD_DATABASE_URL', 'postgres://runtime:secret@localhost/app');
	const result = await runSetupWizard(f.args, f.io, f.execute);
	expect(result.error?.code).toBe('LOCAL_DEMO_UNAVAILABLE');
	expect(f.calls).toHaveLength(1);
});

it('saves confirmed PostgreSQL settings without exposing credentials or executing a database command', async () => {
	const f = await fixture();
	f.io.choose = async () => 'postgresql';
	const result = await runSetupWizard(f.args, f.io, f.execute);
	expect(result.ok).toBe(true);
	expect(JSON.stringify(result)).not.toContain('runtime:secret');
	const file = await readFile(join(f.root, '.env'), 'utf8');
	expect(file).toContain('OTHER_SECRET=unchanged');
	expect(file).toContain("FD_DATABASE_TLS='verify-full'");
	expect(file).toContain('# Keep this');
	expect(f.calls).toHaveLength(1);
});

it('does not write hosted settings after refusal or invalid input', async () => {
	const f = await fixture();
	const before = await readFile(join(f.root, '.env'), 'utf8');
	f.io.choose = async () => 'postgresql';
	f.io.confirm = async () => false;
	await runSetupWizard(f.args, f.io, f.execute);
	expect(await readFile(join(f.root, '.env'), 'utf8')).toBe(before);
	f.io.connection = async () =>
		'postgres://user:secret@host/app\nINJECTED=true';
	expect((await runSetupWizard(f.args, f.io, f.execute)).ok).toBe(false);
	expect(await readFile(join(f.root, '.env'), 'utf8')).toBe(before);
});

it('rejects configuration changed while waiting for confirmation', async () => {
	const f = await fixture();
	f.io.confirm = async () => {
		await writeFile(join(f.root, '.env'), 'CHANGED=true\n');
		return true;
	};
	expect((await runSetupWizard(f.args, f.io, f.execute)).error?.code).toBe(
		'SETUP_CONFIGURATION_CHANGED',
	);
	expect(f.calls.every((call) => !call.flags.has('apply'))).toBe(true);
});

it('refuses symlinked environment files and stale saves', async () => {
	const f = await fixture();
	const before = await readFile(join(f.root, '.env'), 'utf8');
	await writeFile(join(f.root, '.env'), 'CHANGED=true\n');
	await expect(
		saveSetupEnvironment(f.root, before, { FD_DATABASE_ADAPTER: 'postgresql' }),
	).rejects.toThrow('changed');
	await rm(join(f.root, '.env'));
	await writeFile(join(f.root, 'other.env'), before);
	await symlink('other.env', join(f.root, '.env'));
	await expect(
		saveSetupEnvironment(f.root, before, { FD_DATABASE_ADAPTER: 'postgresql' }),
	).rejects.toThrow('regular file');
	expect(await readFile(join(f.root, 'other.env'), 'utf8')).toBe(before);
});

it('serializes concurrent saves without overwriting a newer configuration', async () => {
	const f = await fixture();
	const before = await readFile(join(f.root, '.env'), 'utf8');
	const outcomes = await Promise.allSettled([
		saveSetupEnvironment(f.root, before, { FD_DATABASE_ADAPTER: 'postgresql' }),
		saveSetupEnvironment(f.root, before, { FD_DATABASE_ADAPTER: 'pglite' }),
	]);
	expect(
		outcomes.filter((result) => result.status === 'fulfilled'),
	).toHaveLength(1);
	expect(
		outcomes.filter((result) => result.status === 'rejected'),
	).toHaveLength(1);
});

it('describes loss of all existing local data before a reset', async () => {
	const f = await fixture();
	await mkdir(join(f.root, '.flowdular/data/pglite'), { recursive: true });
	f.io.confirm = async (message) => {
		expect(message).toContain('All existing local data will be deleted');
		return false;
	};
	await runSetupWizard(f.args, f.io, f.execute);
	expect(f.calls.every((call) => !call.flags.has('apply'))).toBe(true);
});
