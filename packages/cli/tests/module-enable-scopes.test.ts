import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLATFORM_API_VERSION } from '@flowdular/contracts';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseArguments } from '../src/arguments.ts';
import { runCommand } from '../src/runner.ts';

let workspace: string;
const environment = { ...process.env };

const SYNC = {
	id: 'auth.scopes.sync',
	version: 1,
	summary: 'Grant the scopes an enabled module declares to every owner.',
	risk: 'process',
	requiresApprovedSpec: false,
	supportsDryRun: true,
};

/* The grant fails the way auth sync-scopes does when the embedded database is
   held by a running platform: the command throws rather than answering. */
const ENTRY = `export default Object.freeze({
	protocolVersion: 1,
	moduleId: 'auth.core',
	commands: [
		{
			path: ['auth', 'sync-scopes'],
			capability: ${JSON.stringify(SYNC)},
			execute: () => {
				throw new Error('The local database is already open in process 4242.');
			},
		},
	],
});
`;

function manifest(id: string, extra: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		id,
		package: `@flowdular/module-${id.split('.')[0]}`,
		version: '1.0.0',
		profile: 'full',
		capabilities: ['api'],
		dependencies: [],
		tenancy: 'required',
		locales: ['en'],
		stability: 'experimental',
		platformApi: `^${PLATFORM_API_VERSION}`,
		platform: { server: true, client: false },
		...extra,
	};
}

async function writeModule(
	directory: string,
	content: Record<string, unknown>,
): Promise<void> {
	const root = join(workspace, 'modules', directory);
	await mkdir(join(root, 'src/cli'), { recursive: true });
	await writeFile(join(root, 'module.json'), JSON.stringify(content, null, 2));
	await mkdir(join(workspace, 'platform/node_modules', `${content.package}`), {
		recursive: true,
	});
}

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'flowdular-module-enable-'));
	await mkdir(join(workspace, 'platform/node_modules'), { recursive: true });
	await writeFile(
		join(workspace, 'flowdular.json'),
		JSON.stringify({ modules: { enabled: ['auth.core'] } }, null, 2),
	);
	await writeFile(
		join(workspace, 'platform/package.json'),
		JSON.stringify({ name: '@test/platform', dependencies: {} }, null, 2),
	);
	await writeModule(
		'auth',
		manifest('auth.core', {
			capabilities: ['api', 'cli'],
			cli: { catalog: 'src/cli/commands.json', entry: 'src/cli/index.ts' },
		}),
	);
	await writeFile(
		join(workspace, 'modules/auth/src/cli/commands.json'),
		JSON.stringify({
			protocolVersion: 1,
			moduleId: 'auth.core',
			commands: [{ path: ['auth', 'sync-scopes'], capability: SYNC }],
		}),
	);
	await writeFile(join(workspace, 'modules/auth/src/cli/index.ts'), ENTRY);
	await writeModule('catalog', manifest('catalog.core'));
	process.env.NODE_ENV = 'development';
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) {
		if (!(key in environment)) delete process.env[key];
	}
	Object.assign(process.env, environment);
});

it('reports a scope grant that throws as MODULE_SCOPES_SYNC_FAILED after enabling the module', async () => {
	const result = await runCommand(
		parseArguments([
			'--root',
			workspace,
			'module',
			'enable',
			'catalog.core',
			'--apply',
		]),
	);

	expect(result).toMatchObject({
		ok: false,
		error: {
			code: 'MODULE_SCOPES_SYNC_FAILED',
			message:
				'Module catalog.core is enabled but its scopes were not granted: The local database is already open in process 4242.',
		},
	});
	expect(
		JSON.parse(await readFile(join(workspace, 'flowdular.json'), 'utf8'))
			.modules.enabled,
	).toContain('catalog.core');
});
