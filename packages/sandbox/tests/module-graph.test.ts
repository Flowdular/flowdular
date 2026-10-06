import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSession, sessionPaths } from '../src/server/sessions.ts';

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function write(path: string, content: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		typeof content === 'string' ? content : JSON.stringify(content),
		'utf8',
	);
}

/* A generated application: its own module under modules/ and the platform
   modules installed with @flowdular/sdk under platform/node_modules. */
async function publishedWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-module-graph-'));
	roots.push(root);
	const sdk = join(root, 'platform/node_modules/@flowdular/sdk');
	await write(join(root, 'flowdular.json'), {
		schemaVersion: 1,
		modules: {
			enabled: ['auth.core', 'example.core', 'workflows.core'],
		},
	});
	await write(join(root, 'platform/package.json'), {
		name: '@app/platform',
		dependencies: { '@flowdular/sdk': '1.0.0' },
	});
	await write(join(root, 'modules/example/module.json'), {
		id: 'example.core',
		package: '@app/module-example',
		dependencies: ['auth.core'],
	});
	await write(join(sdk, 'package.json'), {
		name: '@flowdular/sdk',
		version: '1.0.0',
		exports: {
			'./package.json': './package.json',
			'./modules.json': './modules.json',
		},
	});
	await write(join(sdk, 'modules.json'), {
		schemaVersion: 1,
		modules: ['auth', 'workflows'].map((name) => ({
			manifest: `modules/${name}/module.json`,
			import: `@flowdular/sdk/modules/${name}`,
		})),
	});
	await write(join(sdk, 'modules/auth/module.json'), {
		id: 'auth.core',
		package: '@flowdular/module-auth',
		capabilities: ['cli', 'http'],
		cli: { commands: './src/cli.ts' },
	});
	await write(join(sdk, 'modules/workflows/module.json'), {
		id: 'workflows.core',
		package: '@flowdular/module-workflows',
		dependencies: ['auth.core'],
	});
	return root;
}

function newModuleSession(root: string) {
	return createSession({
		workspaceRoot: root,
		kind: 'new-module',
		moduleId: 'booking.core',
		title: 'Room booking',
		brief: 'Let people book meeting rooms.',
		blueprint: 'new-module@1.0.0',
		role: 'backend-engineer',
		driver: 'fake',
		install: false,
	});
}

it('carries the modules @flowdular/sdk ships into the session module graph', async () => {
	const root = await publishedWorkspace();
	const session = await newModuleSession(root);
	const { workspace } = sessionPaths(root, session.id, session.moduleSuffix);
	const project = JSON.parse(
		await readFile(join(workspace, 'flowdular.json'), 'utf8'),
	) as { modules: { enabled: readonly string[] } };
	expect(project.modules.enabled).toEqual([
		'auth.core',
		'booking.core',
		'example.core',
		'workflows.core',
	]);
	expect(
		JSON.parse(
			await readFile(join(workspace, 'modules/auth/module.json'), 'utf8'),
		),
	).toEqual({
		id: 'auth.core',
		package: '@flowdular/module-auth',
		capabilities: ['http'],
	});
});

it('refuses a session graph in which two modules share a directory name', async () => {
	const root = await publishedWorkspace();
	await write(join(root, 'modules/auth/module.json'), {
		id: 'team-auth.core',
		package: '@app/module-team-auth',
	});
	await expect(newModuleSession(root)).rejects.toMatchObject({
		code: 'MODULE_DIRECTORY_CONFLICT',
	});
});
