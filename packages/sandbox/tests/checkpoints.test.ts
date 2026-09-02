import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRouter } from '@octanejs/app-core';
import {
	DEFAULT_AGENT_ROLES,
	createCodingAgentRegistry,
	type CodingAgentDriver,
	type CodingAgentTurnRequest,
} from '@coreloom/coding-agent';
import {
	MAX_CHECKPOINTS,
	captureCheckpoint,
} from '../src/server/checkpoints.ts';
import { DEFAULT_CONFIGURATION } from '../src/server/config.ts';
import type { PreviewRuntime } from '../src/server/preview-runtime.ts';
import { createSandboxRoutes } from '../src/server/routes.ts';
import type { SandboxRuntime } from '../src/server/runtime.ts';
import {
	appendChatEntry,
	approveSpecification,
	checkpointModulePath,
	createSession,
	readChat,
	readSession,
	restoreCheckpoint,
	sessionPaths,
} from '../src/server/sessions.ts';
import { runTurn, type TurnContext } from '../src/server/turns.ts';

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'coreloom-checkpoints-'));
	await writeFile(
		join(root, 'coreloom.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
		'utf8',
	);
	await writeFile(join(root, 'tsconfig.base.json'), '{}', 'utf8');
	await writeFile(join(root, '.prettierrc.json'), '{}', 'utf8');
	return root;
}

async function newSession(root: string) {
	const session = await createSession({
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
	const specPath = join(
		sessionPaths(root, session.id, session.moduleSuffix).modulePath,
		'spec',
		'module.yaml',
	);
	await mkdir(join(specPath, '..'), { recursive: true });
	await writeFile(specPath, 'status: draft\n', 'utf8');
	return (await approveSpecification(root, session)).session;
}

/* A driver that writes one file into the module and ends with a handoff line. */
function fakeDriver(options: {
	readonly handoff: string;
	readonly file?: string;
	readonly delayMs?: number;
}): CodingAgentDriver {
	return {
		id: 'fake',
		label: 'Fake',
		kind: 'byok',
		requiresLoopback: false,
		description: 'test driver',
		probe: async () => ({ available: true, detail: 'ok', version: '1' }),
		async *run(request: CodingAgentTurnRequest) {
			yield {
				type: 'turn.started',
				driver: 'fake',
				role: request.role,
				resumeId: null,
			};
			await new Promise((resolveDelay) =>
				setTimeout(resolveDelay, options.delayMs ?? 5),
			);
			if (options.file) {
				const target = join(request.workspacePath, options.file);
				await mkdir(join(target, '..'), { recursive: true });
				await writeFile(target, `// ${request.role}\n`, 'utf8');
				yield { type: 'file.changed', path: options.file, change: 'created' };
			}
			yield { type: 'assistant.message', text: `Done.\n\n${options.handoff}` };
			yield {
				type: 'turn.completed',
				resumeId: null,
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				costUsd: null,
				finishReason: 'stop',
			};
		},
	};
}

function turnContext(root: string, driver: CodingAgentDriver): TurnContext {
	return {
		workspaceRoot: root,
		configuration: {
			...DEFAULT_CONFIGURATION,
			mode: 'loopback',
			driver: driver.id,
		},
		registry: createCodingAgentRegistry({
			mode: 'loopback',
			drivers: [driver],
		}),
		roles: DEFAULT_AGENT_ROLES,
		platform: null,
		installDependencies: async () => ({
			ran: false,
			ok: true,
			durationMs: 0,
			output: '',
		}),
	};
}

async function drive(
	context: TurnContext,
	sessionId: string,
	message: string,
	role: string,
): Promise<void> {
	const iterator = runTurn(context, {
		sessionId,
		message,
		role,
		driver: 'fake',
	});
	let step = await iterator.next();
	while (!step.done) step = await iterator.next();
}

function fakeRuntime(root: string, driver: CodingAgentDriver): SandboxRuntime {
	const configuration = {
		...DEFAULT_CONFIGURATION,
		mode: 'loopback' as const,
		driver: driver.id,
	};
	const registry = createCodingAgentRegistry({
		mode: 'loopback',
		drivers: [driver],
	});
	const authority = {
		principal: {
			accountId: 'a',
			tenantId: 't',
			email: 'o@example.test',
			displayName: 'Owner',
			role: 'owner',
			scopes: [],
			tenantName: 'Tenant',
			tenantSlug: 'tenant',
		},
		authority: {
			granted: true as const,
			grantId: 'g',
			capabilities: ['sandbox.access.use'],
			expiresAt: null,
		},
	};
	return {
		workspaceRoot: root,
		configuration: () => configuration,
		registry: () => registry,
		roles: () => DEFAULT_AGENT_ROLES,
		platform: () => null,
		connection: () => ({ connected: true, authority, error: null }),
		refresh: async () => ({ connected: true, authority, error: null }),
		update: async () => ({ connected: true, authority, error: null }),
		openBrowserSession: async (token) => ({
			id: 'b',
			token,
			authority,
			createdAt: Date.now(),
		}),
		browserSession: () => null,
		closeBrowserSession: () => undefined,
	};
}

const preview: PreviewRuntime = {
	compose: () => Promise.reject(new Error('no preview in tests')),
	cached: () => null,
	forget: () => undefined,
	dispose: () => undefined,
};

function api(runtime: SandboxRuntime, port = 4320) {
	const router = createRouter([
		...createSandboxRoutes(runtime, preview, { port }),
	]);
	return async (
		method: string,
		path: string,
		init: { readonly body?: unknown } = {},
	): Promise<Response> => {
		const url = new URL(path, 'http://127.0.0.1:4320');
		const headers: Record<string, string> = {
			host: '127.0.0.1:4320',
			...(init.body !== undefined
				? { 'content-type': 'application/json', 'x-coreloom-sandbox': '1' }
				: {}),
		};
		const request = new Request(url, {
			method,
			headers,
			...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
		});
		const match = router.match(method, url.pathname);
		if (!match || match.route.type !== 'server') {
			return new Response('no route', { status: 404 });
		}
		return match.route.handler({
			request,
			params: match.params,
			url,
			state: new Map(),
		});
	};
}

describe('checkpoint capture', () => {
	it('captures a start checkpoint at creation and excludes node_modules', async () => {
		const root = await workspace();
		const session = await newSession(root);
		expect(session.checkpoints.map((entry) => entry.sequence)).toEqual([0]);
		expect(session.checkpoints[0]!.label).toBe('the starting point');
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await expect(
			stat(checkpointModulePath(paths, 0, session.moduleSuffix)),
		).resolves.toBeDefined();

		await writeFile(
			join(paths.modulePath, 'index.ts'),
			'export const a = 1;\n',
		);
		await mkdir(join(paths.modulePath, 'node_modules', 'left-pad'), {
			recursive: true,
		});
		await writeFile(
			join(paths.modulePath, 'node_modules', 'left-pad', 'index.js'),
			'module.exports = 1;\n',
		);
		const updated = await captureCheckpoint(root, session, 5, {
			label: 'Backend engineer',
			role: 'backend-engineer',
		});
		expect(updated.checkpoints.map((entry) => entry.sequence)).toEqual([0, 5]);
		const snapshot = checkpointModulePath(paths, 5, session.moduleSuffix);
		expect(await readFile(join(snapshot, 'index.ts'), 'utf8')).toBe(
			'export const a = 1;\n',
		);
		await expect(stat(join(snapshot, 'node_modules'))).rejects.toThrow();
	});

	it('writes a checkpoint per turn keyed by the handoff entry', async () => {
		const root = await workspace();
		const session = await newSession(root);
		const context = turnContext(
			root,
			fakeDriver({
				handoff: 'HANDOFF: none - done',
				file: 'modules/booking/src/client/View.tsrx',
			}),
		);
		await drive(context, session.id, 'Add the screen.', 'frontend-engineer');

		const chat = await readChat(root, session);
		const handoff = chat.filter((entry) => entry.handoff).at(-1)!;
		const updated = await readSession(root, session.id);
		const point = updated.checkpoints.find(
			(entry) => entry.sequence === handoff.sequence,
		);
		expect(point).toBeDefined();
		expect(point!.role).toBe('frontend-engineer');
		expect(updated.checkpoints.some((entry) => entry.sequence === 0)).toBe(
			true,
		);

		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		const snapshot = checkpointModulePath(
			paths,
			handoff.sequence,
			session.moduleSuffix,
		);
		expect(
			await readFile(join(snapshot, 'src/client/View.tsrx'), 'utf8'),
		).toContain('frontend-engineer');
	});

	it('keeps at most MAX_CHECKPOINTS and never drops the start', async () => {
		const root = await workspace();
		let session = await newSession(root);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		for (let sequence = 1; sequence <= MAX_CHECKPOINTS + 5; sequence += 1) {
			session = await captureCheckpoint(root, session, sequence, {
				label: `turn ${sequence}`,
				role: 'backend-engineer',
			});
		}
		expect(session.checkpoints).toHaveLength(MAX_CHECKPOINTS);
		expect(session.checkpoints.some((entry) => entry.sequence === 0)).toBe(
			true,
		);
		expect(session.checkpoints.some((entry) => entry.sequence === 1)).toBe(
			false,
		);
		await expect(
			stat(checkpointModulePath(paths, 1, session.moduleSuffix)),
		).rejects.toThrow();
		await expect(
			stat(checkpointModulePath(paths, 0, session.moduleSuffix)),
		).resolves.toBeDefined();
	});
});

describe('checkpoint restore', () => {
	it('restores module files and appends a marker without truncating the transcript', async () => {
		const root = await workspace();
		const session = await newSession(root);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await mkdir(join(paths.modulePath, 'src'), { recursive: true });
		await writeFile(
			join(paths.modulePath, 'src', 'a.ts'),
			'export const a = 1;\n',
		);
		await captureCheckpoint(root, session, 7, {
			label: 'Backend engineer',
			role: 'backend-engineer',
		});

		await writeFile(
			join(paths.modulePath, 'src', 'a.ts'),
			'export const a = 2;\n',
		);
		await writeFile(
			join(paths.modulePath, 'src', 'b.ts'),
			'export const b = 1;\n',
		);
		await mkdir(join(paths.modulePath, 'node_modules', 'dep'), {
			recursive: true,
		});
		await writeFile(
			join(paths.modulePath, 'node_modules', 'dep', 'index.js'),
			'keep',
		);
		await appendChatEntry(root, session, {
			kind: 'user',
			role: 'backend-engineer',
			text: 'change it',
		});
		const before = (await readChat(root, session)).length;

		const restored = await restoreCheckpoint(root, session.id, 7);
		expect(restored.state).toBe('editing');
		expect(await readFile(join(paths.modulePath, 'src', 'a.ts'), 'utf8')).toBe(
			'export const a = 1;\n',
		);
		await expect(stat(join(paths.modulePath, 'src', 'b.ts'))).rejects.toThrow();
		expect(
			await readFile(
				join(paths.modulePath, 'node_modules', 'dep', 'index.js'),
				'utf8',
			),
		).toBe('keep');

		const chat = await readChat(root, session);
		expect(chat).toHaveLength(before + 1);
		expect(chat.at(-1)!.kind).toBe('system');
		expect(chat.at(-1)!.text).toBe(
			'Restored the workspace to the state after Backend engineer (turn 7).',
		);
	});

	it('restores to the pristine starting point', async () => {
		const root = await workspace();
		const session = await newSession(root);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await mkdir(join(paths.modulePath, 'src'), { recursive: true });
		await writeFile(
			join(paths.modulePath, 'src', 'a.ts'),
			'export const a = 1;\n',
		);
		await restoreCheckpoint(root, session.id, 0);
		await expect(stat(join(paths.modulePath, 'src', 'a.ts'))).rejects.toThrow();
	});
});

describe('checkpoint restore route', () => {
	it('validates the request and returns the refreshed view', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(
			root,
			fakeDriver({ handoff: 'HANDOFF: none - done' }),
		);
		const call = api(runtime);
		const session = await newSession(root);

		const hostile = await call(
			'POST',
			'/sandbox/api/sessions/not-a-uuid/checkpoints/restore',
			{ body: { sequence: 0 } },
		);
		expect(hostile.status).toBe(400);

		const absent = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/checkpoints/restore`,
			{ body: {} },
		);
		expect(absent.status).toBe(400);

		const unknown = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/checkpoints/restore`,
			{ body: { sequence: 999 } },
		);
		expect(unknown.status).toBe(400);
		expect(
			((await unknown.json()) as { error: { code: string } }).error.code,
		).toBe('CHECKPOINT_NOT_FOUND');

		const ok = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/checkpoints/restore`,
			{ body: { sequence: 0 } },
		);
		expect(ok.status).toBe(200);
		const view = (await ok.json()) as {
			session: { checkpoints: { sequence: number }[]; state: string };
			running: boolean;
		};
		expect(view.session.checkpoints.some((entry) => entry.sequence === 0)).toBe(
			true,
		);
		expect(view.session.state).toBe('editing');
		expect(view.running).toBe(false);
	});

	it('refuses a checkpoint restore while a turn runs', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(
			root,
			fakeDriver({ handoff: 'HANDOFF: none - done', delayMs: 300 }),
		);
		const call = api(runtime);
		const session = await newSession(root);

		const started = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/turn`,
			{
				body: {
					message: 'Slow work.',
					role: 'backend-engineer',
					driver: 'fake',
				},
			},
		);
		const reader = started.body!.getReader();
		await reader.read();
		await reader.cancel();

		const refused = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/checkpoints/restore`,
			{ body: { sequence: 0 } },
		);
		expect(refused.status).toBe(409);
		expect(
			((await refused.json()) as { error: { code: string } }).error.code,
		).toBe('SESSION_RUNNING');

		await call('POST', `/sandbox/api/sessions/${session.id}/stop`, {
			body: {},
		});
		const view = async () =>
			(
				(await (
					await call('GET', `/sandbox/api/sessions/${session.id}`)
				).json()) as { running: boolean }
			).running;
		const deadline = Date.now() + 5_000;
		while ((await view()) && Date.now() < deadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
		expect(await view()).toBe(false);
	});
});
