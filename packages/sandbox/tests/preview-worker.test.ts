import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIsolatedPreviewRuntime } from '../src/server/preview-worker-manager.ts';
import {
	disposeProcessPreviewRuntime,
	processPreviewRuntime,
} from '../src/server/preview-runtime.ts';
import { createSession, sessionPaths } from '../src/server/sessions.ts';

async function previewSession(platformSource: string) {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-preview-worker-'));
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
		'utf8',
	);
	await writeFile(join(root, 'tsconfig.base.json'), '{}', 'utf8');
	await writeFile(join(root, '.prettierrc.json'), '{}', 'utf8');
	const session = await createSession({
		workspaceRoot: root,
		kind: 'new-module',
		moduleId: 'preview.core',
		title: 'Preview',
		brief: 'Exercise the isolated preview.',
		blueprint: 'new-module@1.0.0',
		role: 'backend-engineer',
		driver: 'fake',
		install: false,
	});
	const modulePath = sessionPaths(
		root,
		session.id,
		session.moduleSuffix,
	).modulePath;
	await mkdir(join(modulePath, 'src'), { recursive: true });
	await writeFile(
		join(modulePath, 'src', 'platform.ts'),
		platformSource,
		'utf8',
	);
	await writeFile(
		join(modulePath, 'src', 'index.ts'),
		'export const permissions: readonly string[] = [];\n',
		'utf8',
	);
	return { root, session, modulePath };
}

describe('isolated preview worker', () => {
	it('does not resurrect a preview forgotten while revision discovery is pending', async () => {
		const { root, session } = await previewSession(
			'export function createServerComposition() { return { routes: [] }; }\n',
		);
		const lifecycle: string[] = [];
		const runtime = createIsolatedPreviewRuntime(root, {
			onWorkerLifecycle: (event) => lifecycle.push(event),
		});
		try {
			const pending = runtime.compose(session);
			await runtime.forget(session.id);
			await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
			expect(runtime.cached(session.id)).toBeNull();
			expect(lifecycle).toEqual([]);
			expect((await runtime.compose(session)).error).toBeNull();
		} finally {
			runtime.dispose();
		}
	}, 30_000);
	it('reloads imported draft dependencies without losing the preview database', async () => {
		const { root, session, modulePath } = await previewSession(
			`import { version } from './handler.ts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function createServerComposition(context) {
  const path = join(context.workspaceRoot, 'data', 'test-key-fingerprint');
  const fingerprint = createHash('sha256').update(context.environment.FD_AGENT_CREDENTIAL_KEY + context.environment.FD_AGENT_RUN_GRANT_KEY).digest('hex');
  if (existsSync(path) && readFileSync(path, 'utf8') !== fingerprint) throw new Error('Preview encryption keys changed');
  writeFileSync(path, fingerprint);
  return { routes: [], start() { throw new Error(version); } };
}\n`,
		);
		const handler = join(modulePath, 'src', 'handler.ts');
		await writeFile(handler, "export const version = 'first version';\n");
		const lifecycle: string[] = [];
		const runtime = createIsolatedPreviewRuntime(root, {
			onWorkerLifecycle: (event) => lifecycle.push(event),
		});
		try {
			const first = await runtime.compose(session);
			expect(first.error).toBe('first version');
			await writeFile(handler, "export const version = 'second version';\n");
			const changed = new Date(Date.now() + 5_000);
			await utimes(handler, changed, changed);
			const second = await runtime.compose(session);
			expect(second.error).toBe('second version');
			expect(second.credentials).toEqual(first.credentials);
			expect(lifecycle).toEqual(['started', 'released', 'started']);
			expect(await runtime.compose(session)).toBe(second);
		} finally {
			runtime.dispose();
		}
	}, 60_000);
	it('composes declared agent and workflow dependencies inside the session', async () => {
		const { root, session, modulePath } = await previewSession(
			'export function createServerComposition() { return { routes: [] }; }\n',
		);
		await writeFile(
			join(modulePath, 'module.json'),
			JSON.stringify({
				id: 'preview.core',
				dependencies: [{ id: 'workflows.core', range: '*' }],
			}),
		);
		const runtime = createIsolatedPreviewRuntime(root, {
			requestTimeoutMs: 30_000,
		});
		try {
			const composition = await runtime.compose(session);
			expect(composition.error).toBeNull();
			/* agents.core declares reports.core and metering.core as dependencies,
			   so a preview that pulls agents composes both registries ahead of it. */
			expect(composition.modules.map((module) => module.id)).toEqual([
				'system.core',
				'reports.core',
				'metering.core',
				'agents.core',
				'workflows.core',
				'preview.core',
			]);
			expect(
				composition.modules.find((module) => module.id === 'agents.core')
					?.support,
			).toBe(true);
			expect(composition.moduleScopes).toContain('agents.definitions.read');
		} finally {
			runtime.dispose();
		}
	}, 60_000);
	it('composes outside the sandbox process and releases every worker', async () => {
		const { root, session } = await previewSession(
			'export function createServerComposition() { return { routes: [] }; }\n',
		);
		const runtime = createIsolatedPreviewRuntime(root);
		const composition = await runtime.compose(session);

		expect(composition.error).toBeNull();
		expect(runtime.cached(session.id)).toBe(composition);
		runtime.dispose();
		expect(runtime.cached(session.id)).toBeNull();
	}, 30_000);

	it('shares one worker across concurrent first requests for a session', async () => {
		const { root, session } = await previewSession(
			'export function createServerComposition() { return { routes: [] }; }\n',
		);
		const lifecycle: string[] = [];
		const runtime = createIsolatedPreviewRuntime(root, {
			onWorkerLifecycle: (event, sessionId) =>
				lifecycle.push(`${event}:${sessionId}`),
		});

		const compositions = await Promise.all([
			runtime.compose(session),
			runtime.compose(session),
			runtime.compose(session),
		]);

		expect(new Set(compositions).size).toBe(1);
		expect(lifecycle).toEqual([`started:${session.id}`]);
		runtime.forget(session.id);
		expect(lifecycle).toEqual([
			`started:${session.id}`,
			`released:${session.id}`,
		]);
	}, 30_000);

	it('reuses the process preview runtime across server route generations', async () => {
		disposeProcessPreviewRuntime();
		const { root, session } = await previewSession(
			'export function createServerComposition() { return { routes: [] }; }\n',
		);
		const otherRoot = await mkdtemp(
			join(tmpdir(), 'flowdular-preview-process-'),
		);
		try {
			const first = processPreviewRuntime(root);
			expect(processPreviewRuntime(root)).toBe(first);

			const replacement = processPreviewRuntime(otherRoot);
			expect(replacement).not.toBe(first);
			await expect(first.compose(session)).rejects.toThrow('already disposed');
		} finally {
			disposeProcessPreviewRuntime();
		}
	});

	it('seals module-owned agent definitions before draft start hooks run', async () => {
		const { root, session } = await previewSession(`
export function createServerComposition(context) {
	context.agentDefinitions.register([
		{ id: 'module-agent:preview.core:helper', moduleId: 'preview.core' },
	]);
	return {
		routes: [],
		start() {
			context.agentDefinitions.register([
				{ id: 'module-agent:preview.core:late' },
			]);
		},
	};
}
`);
		const runtime = createIsolatedPreviewRuntime(root);

		const composition = await runtime.compose(session);

		expect(composition.error).toContain('already sealed');
		runtime.dispose();
	}, 30_000);

	it('kills a draft whose composition exceeds the request deadline', async () => {
		const { root, session } = await previewSession(
			'await new Promise(() => undefined);\nexport function createServerComposition() { return { routes: [] }; }\n',
		);
		const runtime = createIsolatedPreviewRuntime(root, {
			requestTimeoutMs: 100,
		});

		await expect(runtime.compose(session)).rejects.toMatchObject({
			name: 'AbortError',
		});
		expect(runtime.cached(session.id)).toBeNull();
		runtime.dispose();
	});

	it('denies draft reads outside the session root', async () => {
		const { root, session, modulePath } = await previewSession(
			'export function createServerComposition() { return { routes: [] }; }\n',
		);
		const hostSecret = join(root, 'host-secret.txt');
		await writeFile(hostSecret, 'must-not-reach-the-preview', 'utf8');
		await writeFile(
			join(modulePath, 'src', 'platform.ts'),
			`import { readFileSync } from 'node:fs';\nreadFileSync(${JSON.stringify(hostSecret)}, 'utf8');\nexport function createServerComposition() { return { routes: [] }; }\n`,
			'utf8',
		);
		const runtime = createIsolatedPreviewRuntime(root);

		const composition = await runtime.compose(session);

		expect(composition.error).toContain(
			'Access to this API has been restricted',
		);
		expect(composition.error).not.toContain('must-not-reach-the-preview');
		runtime.dispose();
	}, 30_000);

	it('denies draft writes to sandbox session control files', async () => {
		const { root, session, modulePath } = await previewSession(
			'export function createServerComposition() { return { routes: [] }; }\n',
		);
		const record = sessionPaths(
			await realpath(root),
			session.id,
			session.moduleSuffix,
		).record;
		await writeFile(
			join(modulePath, 'src', 'platform.ts'),
			`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(record)}, 'corrupted');\nexport function createServerComposition() { return { routes: [] }; }\n`,
			'utf8',
		);
		const runtime = createIsolatedPreviewRuntime(root);

		const composition = await runtime.compose(session);

		expect(composition.error).toContain(
			'Access to this API has been restricted',
		);
		expect(JSON.parse(await readFile(record, 'utf8'))).toMatchObject({
			id: session.id,
		});
		runtime.dispose();
	}, 30_000);

	it('allows preview databases inside the session data directory', async () => {
		const { root, session, modulePath } = await previewSession(
			'export function createServerComposition() { return { routes: [] }; }\n',
		);
		const data = join(
			sessionPaths(await realpath(root), session.id, session.moduleSuffix).root,
			'.flowdular',
			'data',
		);
		const probe = join(data, 'preview-probe.txt');
		await writeFile(
			join(modulePath, 'src', 'platform.ts'),
			`import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync(${JSON.stringify(data)}, { recursive: true });\nwriteFileSync(${JSON.stringify(probe)}, 'preview-state');\nexport function createServerComposition() { return { routes: [] }; }\n`,
			'utf8',
		);
		const runtime = createIsolatedPreviewRuntime(root);

		const composition = await runtime.compose(session);

		expect(composition.error).toBeNull();
		expect(await readFile(probe, 'utf8')).toBe('preview-state');
		runtime.dispose();
	}, 30_000);
});
