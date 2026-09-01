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
import { DEFAULT_CONFIGURATION } from '../src/server/config.ts';
import type { PreviewRuntime } from '../src/server/preview-runtime.ts';
import { createSandboxRoutes } from '../src/server/routes.ts';
import type { SandboxRuntime } from '../src/server/runtime.ts';
import {
	createSession,
	readChat,
	readSession,
	sessionPaths,
} from '../src/server/sessions.ts';

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'coreloom-routes-'));
	await writeFile(
		join(root, 'coreloom.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
		'utf8',
	);
	return root;
}

/* A driver that writes one file into the module and ends with a handoff line,
   emitting events with a small delay so a consumer can leave mid-turn. */
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
				setTimeout(resolveDelay, options.delayMs ?? 30),
			);
			if (options.file) {
				const target = join(request.workspacePath, options.file);
				await mkdir(join(target, '..'), { recursive: true });
				await writeFile(target, `// ${request.role}\n`, 'utf8');
				yield { type: 'file.changed', path: options.file, change: 'created' };
			}
			await new Promise((resolveDelay) =>
				setTimeout(resolveDelay, options.delayMs ?? 30),
			);
			yield {
				type: 'assistant.message',
				text: `Done.\n\n${options.handoff}`,
			};
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

function fakeRuntime(
	root: string,
	driver: CodingAgentDriver,
	mode: 'loopback' | 'self-hosted' = 'loopback',
): SandboxRuntime {
	const configuration = { ...DEFAULT_CONFIGURATION, mode, driver: driver.id };
	const registry = createCodingAgentRegistry({ mode, drivers: [driver] });
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
			capabilities: ['sandbox.access.use', 'sandbox.modules.eject'],
			expiresAt: null,
		},
	};
	const sessions = new Map<
		string,
		{
			id: string;
			token: string;
			authority: typeof authority;
			createdAt: number;
		}
	>();
	return {
		workspaceRoot: root,
		configuration: () => configuration,
		registry: () => registry,
		roles: () => DEFAULT_AGENT_ROLES,
		platform: () => null,
		connection: () => ({ connected: true, authority, error: null }),
		refresh: async () => ({ connected: true, authority, error: null }),
		update: async () => ({ connected: true, authority, error: null }),
		openBrowserSession: async (token) => {
			const session = {
				id: `b-${sessions.size}`,
				token,
				authority,
				createdAt: Date.now(),
			};
			sessions.set(session.id, session);
			return session;
		},
		browserSession: (id) => (id ? (sessions.get(id) ?? null) : null),
		closeBrowserSession: (id) => {
			sessions.delete(id);
		},
	};
}

const preview: PreviewRuntime = {
	compose: () => Promise.reject(new Error('no preview in tests')),
	cached: () => null,
	forget: () => undefined,
};

function api(runtime: SandboxRuntime, port = 4320) {
	const routes = createSandboxRoutes(runtime, preview, { port });
	const router = createRouter([...routes]);
	return async (
		method: string,
		path: string,
		init: {
			readonly body?: unknown;
			/* An undefined value removes a default header. */
			readonly headers?: Record<string, string | undefined>;
		} = {},
	): Promise<Response> => {
		const url = new URL(path, 'http://127.0.0.1:4320');
		const headers: Record<string, string> = {
			host: '127.0.0.1:4320',
			...(init.body !== undefined
				? { 'content-type': 'application/json', 'x-coreloom-sandbox': '1' }
				: {}),
		};
		for (const [name, value] of Object.entries(init.headers ?? {})) {
			if (value === undefined) delete headers[name];
			else headers[name] = value;
		}
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

async function sessionFor(root: string) {
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

async function readSse(
	response: Response,
): Promise<{ event: string; data: unknown }[]> {
	const text = await response.text();
	return text
		.split('\n\n')
		.filter(Boolean)
		.map((block) => ({
			event: /^event: (.+)$/m.exec(block)?.[1] ?? '',
			data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? 'null') as unknown,
		}));
}

describe('sandbox route security', () => {
	it('rejects a percent-encoded traversal id before touching the disk', async () => {
		const root = await workspace();
		await writeFile(join(root, 'keep.txt'), 'keep');
		const call = api(
			fakeRuntime(root, fakeDriver({ handoff: 'HANDOFF: none - done' })),
		);
		const response = await call(
			'POST',
			'/sandbox/api/sessions/%2e%2e%2f%2e%2e/delete',
			{
				body: {},
			},
		);
		expect(response.status).toBe(400);
		expect(
			((await response.json()) as { error: { code: string } }).error.code,
		).toBe('INVALID_SESSION_ID');
		expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('keep');
		await expect(stat(join(root, 'coreloom.json'))).resolves.toBeDefined();
	});

	it('refuses a mutation without the sandbox header or from another site', async () => {
		const root = await workspace();
		const call = api(
			fakeRuntime(root, fakeDriver({ handoff: 'HANDOFF: none - done' })),
		);
		const session = await sessionFor(root);
		const bare = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/stop`,
			{
				headers: { 'x-coreloom-sandbox': undefined },
				body: {},
			},
		);
		expect(bare.status).toBe(403);
		const missingHeader = await call('POST', '/sandbox/api/config', {
			headers: { 'x-coreloom-sandbox': '' },
			body: { driver: 'fake' },
		});
		expect(missingHeader.status).toBe(403);
		const crossSite = await call('POST', '/sandbox/api/config', {
			headers: { 'sec-fetch-site': 'cross-site' },
			body: { driver: 'fake' },
		});
		expect(crossSite.status).toBe(403);
		const foreignOrigin = await call('POST', '/sandbox/api/config', {
			headers: { origin: 'http://evil.example' },
			body: { driver: 'fake' },
		});
		expect(foreignOrigin.status).toBe(403);
	});

	it('refuses loopback requests addressed to another host or port', async () => {
		const root = await workspace();
		const call = api(
			fakeRuntime(root, fakeDriver({ handoff: 'HANDOFF: none - done' })),
		);
		const wrongPort = await call('GET', '/sandbox/api/state', {
			headers: { host: '127.0.0.1:4310' },
		});
		expect(wrongPort.status).toBe(403);
		const dns = await call('GET', '/sandbox/api/state', {
			headers: { host: 'sandbox.attacker.test:4320' },
		});
		expect(dns.status).toBe(403);
		const ok = await call('GET', '/sandbox/api/state', {
			headers: { host: 'localhost:4320' },
		});
		expect(ok.status).toBe(200);
	});

	it('never accepts a mode change and needs a token with a new address', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(
			root,
			fakeDriver({ handoff: 'HANDOFF: none - done' }),
		);
		const patches: unknown[] = [];
		runtime.update = async (patch) => {
			patches.push(patch);
			return runtime.connection();
		};
		const call = api(runtime);
		const flipped = await call('POST', '/sandbox/api/config', {
			body: { mode: 'loopback', driver: 'fake' },
		});
		expect(flipped.status).toBe(200);
		expect(patches).toEqual([{ driver: 'fake' }]);
		const redirect = await call('POST', '/sandbox/api/config', {
			body: { platformUrl: 'https://attacker.example' },
		});
		expect(redirect.status).toBe(400);
		expect(
			((await redirect.json()) as { error: { code: string } }).error.code,
		).toBe('PLATFORM_TOKEN_REQUIRED');
		expect(patches).toHaveLength(1);
	});

	it('answers a self-hosted browser with 401 until it signs in', async () => {
		const root = await workspace();
		const call = api(
			fakeRuntime(
				root,
				fakeDriver({ handoff: 'HANDOFF: none - done' }),
				'self-hosted',
			),
		);
		const anonymous = await call('GET', '/sandbox/api/state');
		expect(anonymous.status).toBe(401);
		const payload = (await anonymous.json()) as {
			error: { code: string };
			configuration: { mode: string };
			sessions?: unknown;
		};
		expect(payload.error.code).toBe('SANDBOX_SIGN_IN_REQUIRED');
		expect(payload.configuration.mode).toBe('self-hosted');
		expect(payload.sessions).toBeUndefined();

		const connected = await call('POST', '/sandbox/api/connect', {
			body: { token: 'clat_x' },
		});
		expect(connected.status).toBe(200);
		const cookie = connected.headers.get('set-cookie') ?? '';
		expect(cookie).toContain('Secure');
		const signedIn = await call('GET', '/sandbox/api/state', {
			headers: { cookie: cookie.split(';')[0]! },
		});
		expect(signedIn.status).toBe(200);
	});

	it('does not expose host paths in the session view', async () => {
		const root = await workspace();
		const call = api(
			fakeRuntime(root, fakeDriver({ handoff: 'HANDOFF: none - done' })),
		);
		const session = await sessionFor(root);
		const view = (await (
			await call('GET', `/sandbox/api/sessions/${session.id}`)
		).json()) as { paths: { module: string } };
		expect(view.paths.module).toBe('modules/booking');
		expect(JSON.stringify(view)).not.toContain(root);
	});
});

describe('detached turns', () => {
	it('finishes the turn, its gates, and the handoff after the stream consumer leaves', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(
			root,
			fakeDriver({
				handoff: 'HANDOFF: frontend-engineer - the endpoint exists',
				file: 'modules/booking/src/index.ts',
				delayMs: 40,
			}),
		);
		const call = api(runtime);
		const session = await sessionFor(root);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await mkdir(join(paths.modulePath, 'spec'), { recursive: true });
		await writeFile(
			join(paths.modulePath, 'spec', 'module.yaml'),
			'schemaVersion: 1\nid: booking.core\nstatus: approved\nname: Booking\n',
		);
		await writeFile(
			join(paths.modulePath, 'module.json'),
			'{"id":"booking.core"}\n',
		);
		await writeFile(
			join(paths.workspace, 'modules', 'booking', 'package.json'),
			JSON.stringify({ name: '@coreloom/module-booking', dependencies: {} }),
		);
		await runtime.update({ autoContinue: false } as never);

		const response = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/turn`,
			{
				body: {
					message: 'Add the booking endpoint.',
					role: 'backend-engineer',
					driver: 'fake',
				},
			},
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		/* The browser goes away after the first event. */
		const reader = response.body!.getReader();
		await reader.read();
		await reader.cancel();

		const view = async () =>
			(await (
				await call('GET', `/sandbox/api/sessions/${session.id}`)
			).json()) as {
				running: boolean;
			};
		expect((await view()).running).toBe(true);
		const deadline = Date.now() + 10_000;
		while ((await view()).running && Date.now() < deadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
		expect((await view()).running).toBe(false);

		const chat = await readChat(root, session);
		const kinds = chat.map((entry) => entry.kind);
		expect(kinds).toContain('agent');
		const handoffs = chat.filter((entry) => entry.handoff);
		expect(handoffs.length).toBeGreaterThanOrEqual(1);
		expect(
			chat.some((entry) => entry.text?.startsWith('Gate dependencies')),
		).toBe(true);
		const updated = await readSession(root, session.id);
		expect(updated.state).not.toBe('editing');
	});

	it('chains handoffs on the server up to the limit and streams every turn', async () => {
		const root = await workspace();
		let turns = 0;
		const driver = fakeDriver({ handoff: 'HANDOFF: frontend-engineer - next' });
		const chaining: CodingAgentDriver = {
			...driver,
			async *run(request) {
				turns += 1;
				const handoff =
					turns % 2 === 1
						? 'HANDOFF: frontend-engineer - the endpoint exists'
						: 'HANDOFF: backend-engineer - the screen exists';
				yield* fakeDriver({
					handoff,
					file: `modules/booking/src/turn-${turns}.ts`,
					delayMs: 5,
				}).run(request);
			},
		};
		const runtime = fakeRuntime(root, chaining);
		const call = api(runtime);
		const session = await sessionFor(root);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await mkdir(join(paths.modulePath, 'spec'), { recursive: true });
		await writeFile(
			join(paths.modulePath, 'spec', 'module.yaml'),
			'schemaVersion: 1\nid: booking.core\nstatus: approved\nname: Booking\n',
		);
		await writeFile(
			join(paths.modulePath, 'module.json'),
			'{"id":"booking.core"}\n',
		);
		await writeFile(
			join(paths.modulePath, 'package.json'),
			JSON.stringify({ name: '@coreloom/module-booking', dependencies: {} }),
		);

		const response = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/turn`,
			{
				body: {
					message: 'Build it.',
					role: 'backend-engineer',
					driver: 'fake',
				},
			},
		);
		const events = await readSse(response);
		expect(events.filter((entry) => entry.event === 'completed')).toHaveLength(
			4,
		);
		expect(events.at(-1)?.event).toBe('ended');
		expect(turns).toBe(4);
		expect((await readSession(root, session.id)).chainDepth).toBe(3);
	});

	it('refuses to delete a running session unless told to stop it', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(
			root,
			fakeDriver({ handoff: 'HANDOFF: none - done', delayMs: 300 }),
		);
		const call = api(runtime);
		const session = await sessionFor(root);
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
			`/sandbox/api/sessions/${session.id}/delete`,
			{
				body: {},
			},
		);
		expect(refused.status).toBe(409);
		const stopped = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/delete`,
			{
				body: { stop: true },
			},
		);
		expect(stopped.status).toBe(200);
		expect((await readSession(root, session.id)).state).toBe('deleted');
	});
});
