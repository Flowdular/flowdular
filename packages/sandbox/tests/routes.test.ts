import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRouter } from '@octanejs/app-core';
import {
	DEFAULT_AGENT_ROLES,
	CodingAgentError,
	createCodingAgentRegistry,
	type CodingAgentDriver,
	type CodingAgentTurnRequest,
} from '@flowdular/coding-agent';
import { DEFAULT_CONFIGURATION } from '../src/server/config.ts';
import type { PreviewRuntime } from '../src/server/preview-runtime.ts';
import { createSandboxRoutes } from '../src/server/routes.ts';
import {
	PlatformClient,
	type PlatformAuthority,
} from '../src/server/platform-client.ts';
import type { SandboxRuntime } from '../src/server/runtime.ts';
import {
	createSession,
	readChat,
	readSession,
	sessionPaths,
	updateSession,
} from '../src/server/sessions.ts';
import { hashSpec } from '../src/server/spec.ts';
import { settledSession } from './settle.ts';
import type { InstallResult } from '../src/server/workspace-install.ts';

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-routes-'));
	await writeFile(
		join(root, 'flowdular.json'),
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
		aiEnvironment: () => null,
		decisions: () => null,
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
	dispose: () => undefined,
};

function api(
	runtime: SandboxRuntime,
	port = 4320,
	options: {
		readonly realInstall?: boolean;
		readonly installDependencies?: () => Promise<InstallResult>;
	} = {},
) {
	const routes = createSandboxRoutes(runtime, preview, {
		port,
		...(options.realInstall
			? {}
			: {
					installDependencies:
						options.installDependencies ??
						(async () => ({ ran: false, ok: true, durationMs: 0, output: '' })),
				}),
	});
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
				? { 'content-type': 'application/json', 'x-flowdular-sandbox': '1' }
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
	it('installs the standalone SDK before the first agent turn', async () => {
		const root = await workspace();
		try {
			const sdk = join(root, 'platform/node_modules/@flowdular/sdk');
			await mkdir(sdk, { recursive: true });
			await writeFile(
				join(sdk, 'package.json'),
				JSON.stringify({ name: '@flowdular/sdk', version: '0.5.1' }),
			);
			await writeFile(
				join(sdk, 'modules.json'),
				JSON.stringify({ schemaVersion: 1, modules: [] }),
			);
			const driver = fakeDriver({ handoff: 'HANDOFF: none - done' });
			const call = api(fakeRuntime(root, driver), 4320, {
				realInstall: true,
			});
			const response = await call('POST', '/sandbox/api/sessions', {
				body: { brief: 'Build a finance module for tracking expenses.' },
			});
			expect(response.status).toBe(201);
			const created = (await response.json()) as {
				ready: boolean;
				installError: string | null;
				session: { id: string; moduleSuffix: string };
			};
			expect(created).toMatchObject({ ready: true, installError: null });
			const paths = sessionPaths(
				root,
				created.session.id,
				created.session.moduleSuffix,
			);
			expect(
				await realpath(join(paths.workspace, 'node_modules/@flowdular/sdk')),
			).toBe(await realpath(sdk));
			await readSse(
				await call('POST', `/sandbox/api/sessions/${created.session.id}/turn`, {
					body: {
						message: 'Prepare the finance specification.',
						role: 'business-manager',
					},
				}),
			);
			const chat = await readChat(
				root,
				await readSession(root, created.session.id),
			);
			expect(
				chat.some(
					(entry) =>
						entry.event?.type === 'error' &&
						entry.event.code === 'ALLOWED_PATHS_VIOLATION',
				),
			).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('keeps a failed initial install visible and retries before running the agent', async () => {
		const root = await workspace();
		try {
			let installs = 0;
			let runs = 0;
			const driver = fakeDriver({ handoff: 'HANDOFF: none - done' });
			const run = driver.run.bind(driver);
			driver.run = async function* (request) {
				runs += 1;
				yield* run(request);
			};
			const call = api(fakeRuntime(root, driver), 4320, {
				installDependencies: async () => {
					installs += 1;
					return installs < 3
						? {
								ran: true,
								ok: false,
								durationMs: 1,
								output: 'offline package unavailable',
							}
						: { ran: true, ok: true, durationMs: 1, output: '' };
				},
			});
			const response = await call('POST', '/sandbox/api/sessions', {
				body: { brief: 'Build a finance module for tracking expenses.' },
			});
			expect(response.status).toBe(201);
			const created = (await response.json()) as {
				ready: boolean;
				installError: string | null;
				session: { id: string; state: string };
			};
			expect(created.ready).toBe(false);
			expect(created.installError).toContain(
				'dependencies could not be installed',
			);
			expect(created.session.state).toBe('blocked');
			const plannerRuns = runs;
			const createdChat = await readChat(
				root,
				await readSession(root, created.session.id),
			);
			expect(
				createdChat.some((entry) =>
					entry.text?.includes('dependencies could not be installed'),
				),
			).toBe(true);
			expect(JSON.stringify(createdChat)).not.toContain(
				'offline package unavailable',
			);
			const turn = async () =>
				readSse(
					await call(
						'POST',
						`/sandbox/api/sessions/${created.session.id}/turn`,
						{
							body: { message: 'Continue', role: 'business-manager' },
						},
					),
				);
			const settled = () =>
				settledSession(async () => {
					const view = (await (
						await call('GET', `/sandbox/api/sessions/${created.session.id}`)
					).json()) as { running: boolean };
					return view.running;
				});
			await turn();
			await settled();
			expect(runs).toBe(plannerRuns);
			expect((await readSession(root, created.session.id)).state).toBe(
				'blocked',
			);
			await turn();
			await settled();
			expect(runs).toBe(plannerRuns + 1);
			expect(installs).toBe(3);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('returns configuration loaded while reconnecting to a newly started platform', async () => {
		const root = await workspace();
		const base = fakeRuntime(
			root,
			fakeDriver({ handoff: 'HANDOFF: none - done' }),
		);
		let configuration = base.configuration();
		let ready = false;
		const connection = () =>
			ready
				? base.connection()
				: {
						connected: false as const,
						authority: null,
						error: {
							code: 'PLATFORM_TOKEN_MISSING',
							message: 'The local platform is still starting.',
						},
					};
		const runtime: SandboxRuntime = {
			...base,
			configuration: () => configuration,
			connection,
			refresh: async () => {
				configuration = {
					...configuration,
					platformUrl: 'http://127.0.0.1:4311',
				};
				ready = true;
				return connection();
			},
		};
		const response = await api(runtime)('GET', '/sandbox/api/state');
		const state = (await response.json()) as {
			configuration: { platformUrl: string };
			connection: { connected: boolean };
		};
		expect(response.status).toBe(200);
		expect(state.connection.connected).toBe(true);
		expect(state.configuration.platformUrl).toBe('http://127.0.0.1:4311');
	});

	it('isolates dashboard, transcript, actions and preview by account, tenant and platform', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(
			root,
			fakeDriver({ handoff: 'HANDOFF: none - done' }),
			'self-hosted',
		);
		const authority = runtime.connection().authority!;
		runtime.browserSession = (id) =>
			id
				? {
						id,
						token: 'test',
						createdAt: Date.now(),
						authority: {
							...authority,
							principal: {
								...authority.principal,
								accountId: id === 'other-account' ? 'other' : 'a',
								tenantId: id === 'other-tenant' ? 'other' : 't',
							},
						},
					}
				: null;
		const call = api(runtime);
		const session = await sessionFor(root);
		await updateSession(root, session.id, {
			owner: {
				platformUrl: runtime.configuration().platformUrl,
				accountId: 'a',
				tenantId: 't',
			},
		});
		for (const identity of ['other-account', 'other-tenant']) {
			const headers = { cookie: `flowdular_sandbox=${identity}` };
			const state = (await (
				await call('GET', '/sandbox/api/state', { headers })
			).json()) as {
				sessions: unknown[];
				dashboard: { rows: unknown[]; usage: { totalTokens: number } };
				running: string[];
			};
			expect(state.sessions).toEqual([]);
			expect(state.dashboard.rows).toEqual([]);
			expect(state.dashboard.usage.totalTokens).toBe(0);
			for (const [method, suffix] of [
				['GET', ''],
				['GET', '/turn/stream'],
				['GET', '/events'],
				['GET', '/preview'],
				['GET', '/spec'],
				['POST', '/approve'],
				['POST', '/reject'],
				['POST', '/delete'],
				['POST', '/stop'],
				['POST', '/restore'],
				['POST', '/turn'],
			] as const) {
				const response = await call(
					method,
					`/sandbox/api/sessions/${session.id}${suffix}`,
					{ headers, ...(method === 'POST' ? { body: {} } : {}) },
				);
				expect(response.status, method + suffix).toBe(404);
			}
			const previewResponse = await call('GET', '/api/booking/items', {
				headers: {
					cookie: `${headers.cookie}; flowdular_preview_session=${session.id}`,
					referer: `http://127.0.0.1:4320/preview/${session.id}`,
				},
			});
			expect(previewResponse.status).toBe(404);
		}
		const ownHeaders = { cookie: 'flowdular_sandbox=owner' };
		expect(
			(
				await call('GET', `/sandbox/api/sessions/${session.id}`, {
					headers: ownHeaders,
				})
			).status,
		).toBe(200);
		await updateSession(root, session.id, {
			owner: {
				platformUrl: 'https://other.example',
				accountId: 'a',
				tenantId: 't',
			},
		});
		expect(
			(
				await call('GET', `/sandbox/api/sessions/${session.id}`, {
					headers: ownHeaders,
				})
			).status,
		).toBe(404);
	});

	it('records the real operator and planner usage, and preserves usage when an idea is rejected or restored', async () => {
		const root = await workspace();
		const call = api(
			fakeRuntime(root, fakeDriver({ handoff: 'HANDOFF: none - done' })),
		);
		const created = await call('POST', '/sandbox/api/sessions', {
			body: {
				brief: 'Build room booking for our office.',
				driver: 'fake',
				owner: { accountId: 'forged' },
			},
		});
		expect(created.status).toBe(201);
		const { session } = (await created.json()) as {
			session: { id: string; owner: { accountId: string; tenantId: string } };
		};
		expect(session.owner.accountId).toBe('a');
		expect(session.owner.tenantId).toBe('t');
		const snapshot = async () =>
			(await (await call('GET', '/sandbox/api/state')).json()) as {
				dashboard: {
					counts: { rejected: number };
					usage: { totalTokens: number };
					rows: { status: string }[];
				};
			};
		expect((await snapshot()).dashboard.usage.totalTokens).toBe(2);
		expect(
			(
				await call('POST', `/sandbox/api/sessions/${session.id}/reject`, {
					body: {},
				})
			).status,
		).toBe(200);
		expect((await snapshot()).dashboard.counts.rejected).toBe(1);
		expect((await snapshot()).dashboard.usage.totalTokens).toBe(2);
		expect(
			(
				await call('POST', `/sandbox/api/sessions/${session.id}/turn`, {
					body: { message: 'Do more', role: 'auto' },
				})
			).status,
		).toBe(409);
		expect(
			(
				await call('POST', `/sandbox/api/sessions/${session.id}/restore`, {
					body: {},
				})
			).status,
		).toBe(200);
		expect((await snapshot()).dashboard.counts.rejected).toBe(0);
		expect((await snapshot()).dashboard.usage.totalTokens).toBe(2);
	});

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
		await expect(stat(join(root, 'flowdular.json'))).resolves.toBeDefined();
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
				headers: { 'x-flowdular-sandbox': undefined },
				body: {},
			},
		);
		expect(bare.status).toBe(403);
		const missingHeader = await call('POST', '/sandbox/api/config', {
			headers: { 'x-flowdular-sandbox': '' },
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

	it('validates BYOK before persisting and never returns a key', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(
			root,
			fakeDriver({ handoff: 'HANDOFF: none - done' }),
		);
		const patches: Record<string, unknown>[] = [];
		runtime.update = async (patch) => {
			patches.push(patch);
			return runtime.connection();
		};
		const call = api(runtime);
		const invalid = await call('POST', '/sandbox/api/config', {
			body: { byokKind: 'unknown', byokModel: 'model' },
		});
		expect(invalid.status).toBe(400);
		expect(patches).toHaveLength(0);
		const saved = await call('POST', '/sandbox/api/config', {
			body: {
				byokKind: 'openai',
				byokModel: 'model',
				byokCredential: 'synthetic-key',
			},
		});
		expect(saved.status).toBe(200);
		expect(patches[0]).toMatchObject({
			byok: {
				kind: 'openai',
				model: 'model',
				credential: { ciphertext: expect.any(String) },
			},
		});
		expect(await saved.text()).not.toContain('synthetic-key');
	});

	it('validates GitHub settings and seals the provider token', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(
			root,
			fakeDriver({ handoff: 'HANDOFF: none - done' }),
		);
		const patches: Record<string, unknown>[] = [];
		runtime.update = async (patch) => {
			patches.push(patch as Record<string, unknown>);
			return runtime.connection();
		};
		const call = api(runtime);
		const saved = await call('POST', '/sandbox/api/config', {
			body: {
				githubEnabled: true,
				githubOverridesProject: true,
				githubRemote: 'upstream',
				githubRepository: 'example/octane',
				githubBaseBranch: 'develop',
				githubBranchPrefix: 'flowdular',
				githubMode: 'fork',
				githubForkOwner: 'octocat',
				githubReviewers: ['reviewer-one'],
				githubToken: 'github_pat_must_stay_secret',
			},
		});
		expect(saved.status).toBe(200);
		expect(patches).toHaveLength(1);
		expect(patches[0]?.github).toEqual({
			enabled: true,
			overridesProject: true,
			remote: 'upstream',
			repository: 'example/octane',
			baseBranch: 'develop',
			branchPrefix: 'flowdular',
			mode: 'fork',
			forkOwner: 'octocat',
			reviewers: ['reviewer-one'],
		});
		expect(JSON.stringify(patches[0]?.gitProviderToken)).not.toContain(
			'github_pat_must_stay_secret',
		);
		expect(JSON.stringify(await saved.json())).not.toContain(
			'github_pat_must_stay_secret',
		);

		const invalid = await call('POST', '/sandbox/api/config', {
			body: { githubRepository: 'https://github.com/example/octane' },
		});
		expect(invalid.status).toBe(400);
		expect(
			((await invalid.json()) as { error: { code: string } }).error.code,
		).toBe('GITHUB_CONFIG_INVALID');
		const tooManyReviewers = await call('POST', '/sandbox/api/config', {
			body: { githubReviewers: Array.from({ length: 21 }, () => 'octocat') },
		});
		expect(tooManyReviewers.status).toBe(400);
		const oversized = await call('POST', '/sandbox/api/config', {
			body: { githubToken: 'x'.repeat(300_000) },
		});
		expect(oversized.status).toBe(413);
		expect(
			((await oversized.json()) as { error: { code: string } }).error.code,
		).toBe('REQUEST_TOO_LARGE');
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

	it('checks current token write authority before self-hosted configuration and delivery', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(
			root,
			fakeDriver({ handoff: 'HANDOFF: none - done' }),
			'self-hosted',
		);
		const cached = runtime.connection().authority!;
		let current: PlatformAuthority = { ...cached, writeAllowed: true };
		const platformFetch = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => Response.json(current));
		try {
			const browser = await runtime.openBrowserSession('clat_test');
			const headers = { cookie: `flowdular_sandbox=${browser.id}` };
			const patches: unknown[] = [];
			runtime.update = async (patch) => {
				patches.push(patch);
				return runtime.connection();
			};
			const call = api(runtime);
			const allowed = await call('POST', '/sandbox/api/config', {
				headers,
				body: { driver: 'fake' },
			});
			expect(allowed.status).toBe(200);
			expect(patches).toHaveLength(1);

			const session = await sessionFor(root);
			await updateSession(root, session.id, {
				owner: {
					platformUrl: runtime.configuration().platformUrl,
					accountId: cached.principal.accountId,
					tenantId: cached.principal.tenantId,
				},
			});
			const before = await readSession(root, session.id);
			current = { ...cached, writeAllowed: false };
			for (const [path, body] of [
				['/sandbox/api/config', { driver: 'fake' }],
				[`/sandbox/api/sessions/${session.id}/eject`, { apply: false }],
			] as const) {
				const denied = await call('POST', path, { headers, body });
				expect(denied.status, path).toBe(403);
				expect(
					((await denied.json()) as { error: { code: string } }).error.code,
				).toBe('TOKEN_MUTATION_DENIED');
			}
			const previewDenied = await call('POST', '/api/booking/items', {
				headers,
				body: { name: 'blocked' },
			});
			expect(previewDenied.status).toBe(403);
			expect(
				((await previewDenied.json()) as { error: { code: string } }).error
					.code,
			).toBe('TOKEN_MUTATION_DENIED');
			expect(patches).toHaveLength(1);
			expect(await readSession(root, session.id)).toMatchObject({
				state: before.state,
				ejectedAt: before.ejectedAt,
			});

			current = cached;
			const missing = await call('POST', '/sandbox/api/config', {
				headers,
				body: { driver: 'fake' },
			});
			expect(missing.status).toBe(403);
			expect(
				((await missing.json()) as { error: { code: string } }).error.code,
			).toBe('TOKEN_MUTATION_DENIED');
			current = {
				...cached,
				writeAllowed: true,
				authority: { granted: false, reason: 'revoked' },
			};
			const revoked = await call('POST', '/sandbox/api/config', {
				headers,
				body: { driver: 'fake' },
			});
			expect(revoked.status).toBe(403);
			expect(patches).toHaveLength(1);
			current = {
				...cached,
				writeAllowed: true,
				principal: { ...cached.principal, accountId: 'other' },
			};
			const switched = await call('POST', '/sandbox/api/config', {
				headers,
				body: { driver: 'fake' },
			});
			expect(switched.status).toBe(403);
			expect(patches).toHaveLength(1);
			expect(platformFetch).toHaveBeenCalledTimes(7);
		} finally {
			platformFetch.mockRestore();
		}
	});

	it.each(['loopback', 'self-hosted'] as const)(
		'refuses eject in %s after only the eject grant is revoked',
		async (mode) => {
			const root = await workspace();
			const runtime = fakeRuntime(
				root,
				fakeDriver({ handoff: 'HANDOFF: none - done' }),
				mode,
			);
			const cached = runtime.connection().authority!;
			let current: PlatformAuthority = { ...cached, writeAllowed: true };
			const live = vi.fn(async () => Response.json(current));
			const fetchSpy =
				mode === 'self-hosted'
					? vi.spyOn(globalThis, 'fetch').mockImplementation(live)
					: null;
			if (mode === 'loopback') {
				runtime.platform = () =>
					new PlatformClient({
						platformUrl: runtime.configuration().platformUrl,
						token: 'test',
						fetch: live,
					});
			}
			try {
				const browser =
					mode === 'self-hosted'
						? await runtime.openBrowserSession('clat_test')
						: null;
				const headers = browser
					? { cookie: `flowdular_sandbox=${browser.id}` }
					: {};
				const session = await sessionFor(root);
				if (mode === 'self-hosted') {
					await updateSession(root, session.id, {
						owner: {
							platformUrl: runtime.configuration().platformUrl,
							accountId: cached.principal.accountId,
							tenantId: cached.principal.tenantId,
						},
					});
				}
				const before = await readSession(root, session.id);
				current = {
					...cached,
					writeAllowed: true,
					authority: {
						granted: true,
						grantId: 'g',
						capabilities: ['sandbox.access.use'],
						expiresAt: null,
					},
				};
				const call = api(runtime);
				for (const apply of [false, true]) {
					const denied = await call(
						'POST',
						`/sandbox/api/sessions/${session.id}/eject`,
						{ headers, body: { apply } },
					);
					expect(denied.status).toBe(403);
					expect(
						((await denied.json()) as { error: { code: string } }).error.code,
					).toBe('EJECT_SCOPE_MISSING');
				}
				expect(live).toHaveBeenCalled();
				expect(await readSession(root, session.id)).toMatchObject({
					state: before.state,
					ejectedAt: before.ejectedAt,
				});
			} finally {
				fetchSpy?.mockRestore();
				await rm(root, { recursive: true, force: true });
			}
		},
	);

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
	it('blocks automatic continuation when the agent exceeds its time limit', async () => {
		const root = await workspace();
		const driver = fakeDriver({ handoff: 'HANDOFF: none - done' });
		const regularRun = driver.run.bind(driver);
		let attempts = 0;
		const resumeRequests: (string | null | undefined)[] = [];
		driver.run = async function* (request) {
			attempts++;
			resumeRequests.push(request.resumeId);
			if (attempts > 1) {
				/* Codex can report a locked old writer and complete on a fresh
				   thread. That notice must not fail the recovered turn. */
				yield {
					type: 'error',
					code: 'DRIVER_THREAD_LOCKED',
					message: 'Continuing on a new thread.',
				} as const;
				for await (const event of regularRun(request))
					yield event.type === 'turn.started' || event.type === 'turn.completed'
						? { ...event, resumeId: 'new-thread' }
						: event;
				return;
			}
			yield {
				type: 'turn.started',
				driver: 'fake',
				role: request.role,
				resumeId: 'timed-out-thread',
			} as const;
			yield { type: 'activity', phase: 'thinking' };
			throw new CodingAgentError(
				'DRIVER_TIMEOUT',
				'The coding agent exceeded the turn time limit. Review the draft before continuing.',
			);
		};
		const call = api(fakeRuntime(root, driver));
		const session = await sessionFor(root);
		await updateSession(root, session.id, { autoContinue: true });
		await readSse(
			await call('POST', `/sandbox/api/sessions/${session.id}/turn`, {
				body: { role: 'business-manager', message: 'Continue', driver: 'fake' },
			}),
		);
		const chat = await readChat(root, session);
		expect(attempts).toBe(1);
		expect(
			chat.some((entry) =>
				entry.text?.includes('exceeded the turn time limit'),
			),
		).toBe(true);
		expect(chat.filter((entry) => entry.handoff).at(-1)?.handoff?.kind).toBe(
			'blocked',
		);
		expect(chat.some((entry) => entry.text?.startsWith('Gate '))).toBe(false);
		const view = (await (
			await call('GET', `/sandbox/api/sessions/${session.id}`)
		).json()) as { running: boolean };
		expect(view.running).toBe(false);
		expect(
			Object.values((await readSession(root, session.id)).resumeIds),
		).toContain('timed-out-thread');
		await readSse(
			await call('POST', `/sandbox/api/sessions/${session.id}/turn`, {
				body: {
					role: 'business-manager',
					message: 'Finish the draft',
					driver: 'fake',
				},
			}),
		);
		expect(resumeRequests[1]).toBe('timed-out-thread');
		const recovered = await readSession(root, session.id);
		expect(recovered.state).not.toBe('failed');
		expect(Object.values(recovered.resumeIds)).toContain('new-thread');
	});

	it('resumes only the same role and scope, never a previous specialist conversation', async () => {
		const root = await workspace();
		const requests: CodingAgentTurnRequest[] = [];
		const driver = fakeDriver({ handoff: 'HANDOFF: none - done' });
		const run = driver.run.bind(driver);
		driver.run = async function* (request) {
			requests.push(request);
			for await (const event of run(request))
				yield event.type === 'turn.completed'
					? { ...event, resumeId: `context-${requests.length}` }
					: event;
		};
		const runtime = fakeRuntime(root, driver);
		const call = api(runtime);
		const session = await sessionFor(root);
		await updateSession(root, session.id, {
			autoContinue: false,
			resumeIds: { fake: 'legacy-shared-context' },
		});
		const turn = async (role: string, message = 'Continue') =>
			readSse(
				await call('POST', `/sandbox/api/sessions/${session.id}/turn`, {
					body: { role, message },
				}),
			);
		await turn('business-manager');
		expect(requests[0]?.resumeId).toBeNull();
		await turn('business-manager');
		expect(requests[1]?.resumeId).toBe('context-1');
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await mkdir(join(paths.modulePath, 'spec'), { recursive: true });
		const spec =
			'schemaVersion: 1\nid: booking.core\nstatus: approved\nname: Booking\n';
		await writeFile(join(paths.modulePath, 'spec/module.yaml'), spec);
		await writeFile(
			join(paths.modulePath, 'module.json'),
			'{"id":"booking.core"}',
		);
		await updateSession(root, session.id, {
			modules: session.modules.map((module) => ({
				...module,
				specHash: hashSpec(spec),
				specApprovedAt: Date.now(),
			})),
		});
		await turn('backend-engineer');
		expect(requests[2]?.resumeId).toBeNull();
		expect(requests[2]?.allowedPaths).not.toContain(
			'modules/booking/src/client/**',
		);
		await turn('backend-engineer');
		expect(requests[3]?.resumeId).toBe('context-3');
		await turn('frontend-engineer');
		expect(requests[4]?.resumeId).toBeNull();
		expect(
			Object.keys((await readSession(root, session.id)).resumeIds),
		).toHaveLength(1);
	});

	it('starts fresh context without losing the brief, transcript or draft files', async () => {
		const root = await workspace();
		const requests: CodingAgentTurnRequest[] = [];
		const driver = fakeDriver({ handoff: 'HANDOFF: none - done' });
		const run = driver.run.bind(driver);
		driver.run = async function* (request) {
			requests.push(request);
			yield* run(request);
		};
		const call = api(fakeRuntime(root, driver));
		const session = await sessionFor(root);
		await updateSession(root, session.id, {
			resumeIds: { fake: 'old-context' },
			autoContinue: false,
		});
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await writeFile(join(paths.modulePath, 'keep.txt'), 'draft');
		await readSse(
			await call('POST', `/sandbox/api/sessions/${session.id}/turn`, {
				body: {
					message: 'Continue planning',
					role: 'business-manager',
					freshContext: true,
				},
			}),
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.resumeId).toBeNull();
		expect(requests[0]?.history).toContainEqual({
			role: 'user',
			text: session.brief,
		});
		expect(await readFile(join(paths.modulePath, 'keep.txt'), 'utf8')).toBe(
			'draft',
		);
		expect(
			(await readChat(root, session)).some(
				(entry) => entry.text === 'Continue planning',
			),
		).toBe(true);
	});

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
			JSON.stringify({ name: '@flowdular/module-booking', dependencies: {} }),
		);
		const approvedText = await readFile(
			join(paths.modulePath, 'spec', 'module.yaml'),
			'utf8',
		);
		await updateSession(root, session.id, {
			modules: session.modules.map((module) => ({
				...module,
				specHash: hashSpec(approvedText),
				specApprovedAt: Date.now(),
			})),
		});
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
		await settledSession(async () => (await view()).running);
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
	}, 60_000);

	it('stops a repair chain after the repair limit and streams every turn', async () => {
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
					file: `modules/booking/src/domain/turn-${turns}.ts`,
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
			JSON.stringify({ name: '@flowdular/module-booking', dependencies: {} }),
		);
		const approvedText = await readFile(
			join(paths.modulePath, 'spec', 'module.yaml'),
			'utf8',
		);
		await updateSession(root, session.id, {
			modules: session.modules.map((module) => ({
				...module,
				specHash: hashSpec(approvedText),
				specApprovedAt: Date.now(),
			})),
		});

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
		/* This fixture changes a file every turn, so every handoff is a gate
		   repair. The chain stops at the repair limit rather than running to the
		   turn limit, which is what keeps a module that cannot satisfy a gate
		   from spending the operator's budget. */
		expect(events.filter((entry) => entry.event === 'completed')).toHaveLength(
			3,
		);
		expect(
			events.some((entry) =>
				String((entry.data as { text?: unknown } | null)?.text ?? '').includes(
					'consecutive gate-repair',
				),
			),
		).toBe(true);
		expect(events.at(-1)?.event).toBe('ended');
		expect(turns).toBe(3);
		expect((await readSession(root, session.id)).chainDepth).toBe(2);
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

/* Reads one event stream as it arrives. Comment lines are keepalives, not
   events, so they are skipped. */
function eventReader(response: Response) {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	return {
		async next(): Promise<{ readonly event: string; readonly data: unknown }> {
			for (;;) {
				const end = buffer.indexOf('\n\n');
				if (end >= 0) {
					const block = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const event = /^event: (.+)$/m.exec(block)?.[1];
					if (!event) continue;
					return {
						event,
						data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? 'null'),
					};
				}
				const chunk = await reader.read();
				if (chunk.done) throw new Error('The event stream ended.');
				buffer += decoder.decode(chunk.value, { stream: true });
			}
		},
		close: () => reader.cancel(),
	};
}

describe('following a session from another client', () => {
	/* A turn that stays running until the test lets it go, so "running" is a
	   state the test controls instead of a race it hopes to win. */
	function heldDriver() {
		let release = () => undefined as void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const base = fakeDriver({ handoff: 'HANDOFF: none - done', delayMs: 0 });
		const driver: CodingAgentDriver = {
			...base,
			async *run(request: CodingAgentTurnRequest) {
				await held;
				yield* base.run(request);
			},
		};
		return { driver, release };
	}

	it('tells an open view that another client started a turn, finished it and approved', async () => {
		const root = await workspace();
		const { driver, release } = heldDriver();
		const call = api(fakeRuntime(root, driver));
		const session = await sessionFor(root);
		const view = async () =>
			(await (
				await call('GET', `/sandbox/api/sessions/${session.id}`)
			).json()) as {
				running: boolean;
				specs: readonly { approved: boolean | null }[];
			};

		const watching = await call(
			'GET',
			`/sandbox/api/sessions/${session.id}/events`,
		);
		expect(watching.status).toBe(200);
		expect(watching.headers.get('content-type')).toContain('text/event-stream');
		const tab = eventReader(watching);
		expect(await tab.next()).toEqual({
			event: 'ready',
			data: { sessionId: session.id, running: false },
		});

		/* Another client starts a turn. */
		const turn = call('POST', `/sandbox/api/sessions/${session.id}/turn`, {
			body: { role: 'business-manager', message: 'Draft it', driver: 'fake' },
		});
		expect(await tab.next()).toEqual({
			event: 'changed',
			data: { sessionId: session.id, running: true },
		});
		expect((await view()).running).toBe(true);

		/* The turn finishes. Every change while it ran says so; the view hears
		   the one that says it stopped, and reloads to a finished session. */
		release();
		await readSse(await turn);
		let event = await tab.next();
		while ((event.data as { running: boolean }).running) {
			event = await tab.next();
		}
		expect(event.event).toBe('changed');
		expect((await view()).running).toBe(false);

		/* A change to the record alone reaches the view too. */
		await call('POST', `/sandbox/api/sessions/${session.id}/settings`, {
			body: { autoContinue: false },
		});
		expect((await tab.next()).event).toBe('changed');
		await tab.close();

		/* Another client approves the draft the agent left. */
		const specPath = join(
			sessionPaths(root, session.id, session.moduleSuffix).workspace,
			'modules',
			'booking',
			'spec',
			'module.yaml',
		);
		const spec = 'schemaVersion: 1\nid: booking.core\nstatus: draft\n';
		await mkdir(join(specPath, '..'), { recursive: true });
		await writeFile(specPath, spec, 'utf8');
		const second = eventReader(
			await call('GET', `/sandbox/api/sessions/${session.id}/events`),
		);
		expect((await second.next()).event).toBe('ready');
		const approved = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/approve`,
			{ body: { module: 'booking', specHash: hashSpec(spec) } },
		);
		expect(approved.status).toBe(200);
		expect((await second.next()).event).toBe('changed');
		expect((await view()).specs[0]!.approved).toBe(true);
		await second.close();
	});

	it('releases a closed view and refuses views past the bound', async () => {
		const root = await workspace();
		const call = api(
			fakeRuntime(root, fakeDriver({ handoff: 'HANDOFF: none - done' })),
		);
		const session = await sessionFor(root);
		const open = () =>
			call('GET', `/sandbox/api/sessions/${session.id}/events`);

		/* Closing a view gives its place back, however often tabs come and go. */
		for (let index = 0; index < 40; index += 1) {
			const response = await open();
			expect(response.status).toBe(200);
			await response.body!.cancel();
		}

		const views = [];
		for (let index = 0; index < 32; index += 1) {
			const response = await open();
			expect(response.status).toBe(200);
			views.push(response);
		}
		const refused = await open();
		expect(refused.status).toBe(429);
		expect(
			((await refused.json()) as { error: { code: string } }).error.code,
		).toBe('SESSION_WATCHERS_EXHAUSTED');
		for (const response of views) await response.body!.cancel();
		const reopened = await open();
		expect(reopened.status).toBe(200);
		await reopened.body!.cancel();
	});
});
