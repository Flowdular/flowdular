import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
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
	const root = await mkdtemp(join(tmpdir(), 'coreloom-preview-worker-'));
	await writeFile(
		join(root, 'coreloom.json'),
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
	});

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
	});

	it('reuses the process preview runtime across server route generations', async () => {
		disposeProcessPreviewRuntime();
		const { root, session } = await previewSession(
			'export function createServerComposition() { return { routes: [] }; }\n',
		);
		const otherRoot = await mkdtemp(
			join(tmpdir(), 'coreloom-preview-process-'),
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
		{ id: 'module-agent:preview.core:helper' },
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
	});

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
	});

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
	});

	it('allows preview databases inside the session data directory', async () => {
		const { root, session, modulePath } = await previewSession(
			'export function createServerComposition() { return { routes: [] }; }\n',
		);
		const data = join(
			sessionPaths(await realpath(root), session.id, session.moduleSuffix).root,
			'.coreloom',
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
	});
});
