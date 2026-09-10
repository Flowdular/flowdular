import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function invoke(
	fileAdapter: string | null,
	adapter?: string,
	unreadable = false,
) {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-program-env-'));
	roots.push(root);
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ modules: { enabled: ['probe.core'] } }),
	);
	const moduleRoot = join(root, 'modules/probe');
	await mkdir(join(moduleRoot, 'src/cli'), { recursive: true });
	const capability = {
		id: 'probe.environment',
		version: 1,
		summary: 'Inspect configuration without opening a database.',
		risk: 'read',
		requiresApprovedSpec: false,
		supportsDryRun: false,
	};
	const command = { path: ['probe', 'environment'], capability };
	await writeFile(
		join(moduleRoot, 'module.json'),
		JSON.stringify({
			id: 'probe.core',
			cli: { catalog: 'src/cli/commands.json', entry: 'src/cli/index.ts' },
		}),
	);
	await writeFile(
		join(moduleRoot, 'src/cli/commands.json'),
		JSON.stringify({
			protocolVersion: 1,
			moduleId: 'probe.core',
			commands: [command],
		}),
	);
	await writeFile(
		join(moduleRoot, 'src/cli/index.ts'),
		`export default { protocolVersion: 1, moduleId: 'probe.core', commands: [{...${JSON.stringify(command)}, execute() { return { data: { adapter: process.env.FD_DATABASE_ADAPTER ?? null } }; }}] };`,
	);
	if (unreadable) await mkdir(join(root, '.env'));
	else if (fileAdapter !== null)
		await writeFile(
			join(root, '.env'),
			'FD_DATABASE_ADAPTER=' + fileAdapter + '\n',
		);
	const environment = { ...process.env };
	delete environment.FD_DATABASE_ADAPTER;
	if (adapter) environment.FD_DATABASE_ADAPTER = adapter;
	const { stdout } = await promisify(execFile)(
		process.execPath,
		[
			'--import',
			'tsx',
			resolve('src/index.ts'),
			'--root',
			root,
			'probe',
			'environment',
			'--json',
		],
		{ env: environment },
	).catch((error: unknown) => {
		if (
			error &&
			typeof error === 'object' &&
			'stdout' in error &&
			typeof error.stdout === 'string' &&
			error.stdout.trim()
		)
			return { stdout: error.stdout };
		throw error;
	});
	return JSON.parse(stdout) as {
		ok: boolean;
		data: { adapter: string | null };
	};
}

it('loads database configuration from the selected workspace before invoking a command', async () => {
	expect(await invoke('postgresql')).toMatchObject({
		ok: true,
		data: { adapter: 'postgresql' },
	});
});

it('refuses an unreadable environment file instead of running with fallback configuration', async () => {
	expect(await invoke(null, undefined, true)).toMatchObject({
		ok: false,
		error: { code: 'ENVIRONMENT_FILE_UNREADABLE' },
	});
});
it('preserves real environment overrides and supports workspaces without an env file', async () => {
	expect(await invoke('postgresql', 'pglite')).toMatchObject({
		ok: true,
		data: { adapter: 'pglite' },
	});
	expect(await invoke(null)).toMatchObject({
		ok: true,
		data: { adapter: null },
	});
});
