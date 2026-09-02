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
import { createLocalDeliveryTarget } from '../src/server/delivery/index.ts';
import type {
	CommandRunner,
	DeliveryContext,
} from '../src/server/delivery/index.ts';
import type { PreviewRuntime } from '../src/server/preview-runtime.ts';
import { createSandboxRoutes } from '../src/server/routes.ts';
import type { SandboxRuntime } from '../src/server/runtime.ts';
import {
	createSession,
	approveSpecification,
	readChat,
	readSession,
	sessionPaths,
	updateSession,
	type SandboxSession,
} from '../src/server/sessions.ts';
import { hashSpec } from '../src/server/spec.ts';
import {
	runTurn,
	type TurnContext,
	type TurnOutcome,
} from '../src/server/turns.ts';

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'coreloom-multi-'));
	await writeFile(
		join(root, 'coreloom.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
		'utf8',
	);
	await writeFile(join(root, 'tsconfig.base.json'), '{}', 'utf8');
	await writeFile(join(root, '.prettierrc.json'), '{}', 'utf8');
	for (const [directory, id] of [
		['parties', 'parties.core'],
		['catalog', 'catalog.core'],
		['expenses', 'expenses.core'],
	] as const) {
		await mkdir(join(root, 'modules', directory, 'src'), { recursive: true });
		await mkdir(join(root, 'modules', directory, 'spec'), { recursive: true });
		await writeFile(
			join(root, 'modules', directory, 'module.json'),
			`${JSON.stringify({ id })}\n`,
			'utf8',
		);
		await writeFile(
			join(root, 'modules', directory, 'package.json'),
			`${JSON.stringify({ name: `@coreloom/module-${directory}` })}\n`,
			'utf8',
		);
		await writeFile(
			join(root, 'modules', directory, 'src', 'index.ts'),
			`export const ${directory} = 1;\n`,
			'utf8',
		);
		await writeFile(
			join(root, 'modules', directory, 'spec', 'module.yaml'),
			`status: approved\n`,
			'utf8',
		);
	}
	return root;
}

/* A session over parties.core and catalog.core, parties first. */
async function twoModuleSession(root: string): Promise<SandboxSession> {
	let session = await createSession({
		workspaceRoot: root,
		kind: 'edit-module',
		moduleId: 'parties.core',
		modules: [
			{ id: 'parties.core', directory: 'parties', kind: 'edit' },
			{ id: 'catalog.core', directory: 'catalog', kind: 'edit' },
		],
		title: 'VAT across modules',
		brief: 'Add a VAT field in parties.core and show it in catalog.core.',
		blueprint: 'edit-module@1.0.0',
		role: 'backend-engineer',
		driver: 'fake',
		sourceModule: 'parties',
		install: false,
	});
	for (const module of session.modules) {
		session = (await approveSpecification(root, session, module)).session;
	}
	return session;
}

/* Records what the driver was handed and optionally writes one file, so a test
   can read the composed instruction and produce a diff in one module. */
function recordingDriver(
	sink: { instruction: string; prompt: string },
	options: { readonly file?: string; readonly delayMs?: number } = {},
): CodingAgentDriver {
	return {
		id: 'fake',
		label: 'Fake',
		kind: 'byok',
		requiresLoopback: false,
		description: 'test driver',
		probe: async () => ({ available: true, detail: 'ok', version: '1' }),
		async *run(request: CodingAgentTurnRequest) {
			sink.instruction = request.systemInstruction ?? '';
			sink.prompt = request.prompt;
			yield {
				type: 'turn.started',
				driver: 'fake',
				role: request.role,
				resumeId: null,
			};
			if (options.delayMs) {
				await new Promise((resolveDelay) =>
					setTimeout(resolveDelay, options.delayMs),
				);
			}
			if (options.file) {
				const target = join(request.workspacePath, options.file);
				await mkdir(join(target, '..'), { recursive: true });
				await writeFile(target, `// ${request.role}\n`, 'utf8');
				yield { type: 'file.changed', path: options.file, change: 'created' };
			}
			yield {
				type: 'assistant.message',
				text: 'Done.\n\nHANDOFF: none - done',
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
	input: { readonly message: string; readonly module?: string },
): Promise<TurnOutcome> {
	const iterator = runTurn(context, {
		sessionId,
		message: input.message,
		role: 'backend-engineer',
		driver: 'fake',
		...(input.module ? { module: input.module } : {}),
	});
	let step = await iterator.next();
	while (!step.done) step = await iterator.next();
	return step.value;
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
			capabilities: ['sandbox.access.use', 'sandbox.modules.eject'],
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
		openBrowserSession: async () => {
			throw new Error('not used');
		},
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

describe('the session view', () => {
	it('lists every module of the session with its workspace path', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(
			root,
			recordingDriver({ instruction: '', prompt: '' }),
		);
		const session = await twoModuleSession(root);
		const view = (await (
			await api(runtime)('GET', `/sandbox/api/sessions/${session.id}`)
		).json()) as {
			session: SandboxSession;
			paths: {
				module: string;
				modules: readonly { id: string; path: string }[];
			};
		};
		expect(view.session.modules.map((module) => module.id)).toEqual([
			'parties.core',
			'catalog.core',
		]);
		expect(view.paths.modules).toEqual([
			{ id: 'parties.core', path: 'modules/parties' },
			{ id: 'catalog.core', path: 'modules/catalog' },
		]);
		expect(view.paths.module).toBe('modules/parties');
	});
});

describe('creating a session from a brief that names two modules', () => {
	it('materializes both modules and names them in the first system entry', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(
			root,
			recordingDriver({ instruction: '', prompt: '' }),
		);
		const response = await api(runtime)('POST', '/sandbox/api/sessions', {
			body: {
				brief:
					'Add a VAT field to parties.core and show it on the catalog.core screen.',
				driver: 'fake',
			},
		});
		expect(response.status).toBe(201);
		const created = (await response.json()) as {
			session: SandboxSession;
			plan: { modules: readonly { id: string; directory: string }[] };
		};
		expect(created.plan.modules.map((module) => module.id)).toEqual([
			'parties.core',
			'catalog.core',
		]);
		expect(created.session.modules.map((module) => module.directory)).toEqual([
			'parties',
			'catalog',
		]);

		const paths = sessionPaths(
			root,
			created.session.id,
			created.session.moduleSuffix,
		);
		for (const directory of ['parties', 'catalog']) {
			await expect(
				stat(join(paths.workspace, 'modules', directory, 'src', 'index.ts')),
			).resolves.toBeDefined();
			await expect(
				stat(join(paths.base, 'modules', directory, 'src', 'index.ts')),
			).resolves.toBeDefined();
		}
		const chat = await readChat(root, created.session);
		expect(chat[0]?.kind).toBe('system');
		expect(chat[0]?.text).toContain('parties.core (modules/parties)');
		expect(chat[0]?.text).toContain('catalog.core (modules/catalog)');
	});
});

describe('adding a module to a running session', () => {
	it('materializes the module, its base, and records it in the transcript', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(
			root,
			recordingDriver({ instruction: '', prompt: '' }),
		);
		const call = api(runtime);
		const session = await createSession({
			workspaceRoot: root,
			kind: 'edit-module',
			moduleId: 'parties.core',
			title: 'VAT',
			brief: 'Add a VAT field to parties.core.',
			blueprint: 'edit-module@1.0.0',
			role: 'backend-engineer',
			driver: 'fake',
			sourceModule: 'parties',
			install: false,
		});

		const response = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/modules`,
			{ body: { moduleId: 'catalog.core' } },
		);
		expect(response.status).toBe(201);
		const view = (await response.json()) as { session: SandboxSession };
		expect(view.session.modules).toEqual([
			{ id: 'parties.core', directory: 'parties', kind: 'edit' },
			{ id: 'catalog.core', directory: 'catalog', kind: 'edit' },
		]);
		/* The primary module never moves, so everything keyed on it still works. */
		expect(view.session.moduleId).toBe('parties.core');
		expect(view.session.moduleSuffix).toBe('parties');

		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		expect(
			await readFile(
				join(paths.workspace, 'modules', 'catalog', 'src', 'index.ts'),
				'utf8',
			),
		).toBe('export const catalog = 1;\n');
		expect(
			await readFile(
				join(paths.base, 'modules', 'catalog', 'src', 'index.ts'),
				'utf8',
			),
		).toBe('export const catalog = 1;\n');
		const enabled = JSON.parse(
			await readFile(join(paths.workspace, 'coreloom.json'), 'utf8'),
		) as { modules: { enabled: readonly string[] } };
		expect(enabled.modules.enabled).toContain('catalog.core');
		const chat = await readChat(root, await readSession(root, session.id));
		expect(
			chat.some(
				(entry) =>
					entry.kind === 'system' &&
					entry.module === 'catalog' &&
					(entry.text ?? '').includes('catalog.core'),
			),
		).toBe(true);
	});

	it('refuses an unknown module and one the session already has', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(
			root,
			recordingDriver({ instruction: '', prompt: '' }),
		);
		const call = api(runtime);
		const session = await twoModuleSession(root);

		const unknown = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/modules`,
			{ body: { moduleId: 'nowhere.core' } },
		);
		expect(unknown.status).toBe(404);
		expect(
			((await unknown.json()) as { error: { code: string } }).error.code,
		).toBe('MODULE_NOT_FOUND');

		const duplicate = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/modules`,
			{ body: { moduleId: 'catalog.core' } },
		);
		expect(duplicate.status).toBe(409);
		expect(
			((await duplicate.json()) as { error: { code: string } }).error.code,
		).toBe('MODULE_ALREADY_IN_SESSION');
		expect((await readSession(root, session.id)).modules).toHaveLength(2);
	});

	it('refuses while a turn runs', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(
			root,
			recordingDriver({ instruction: '', prompt: '' }, { delayMs: 300 }),
		);
		const call = api(runtime);
		const session = await twoModuleSession(root);

		const started = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/turn`,
			{
				body: {
					message: 'Work slowly.',
					role: 'backend-engineer',
					driver: 'fake',
				},
			},
		);
		const reader = started.body!.getReader();
		await reader.read();
		const running = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/modules`,
			{ body: { moduleId: 'expenses.core' } },
		);
		expect(running.status).toBe(409);
		expect(
			((await running.json()) as { error: { code: string } }).error.code,
		).toBe('SESSION_RUNNING');
		await call('POST', `/sandbox/api/sessions/${session.id}/stop`, {
			body: {},
		});
		await reader.cancel();
		expect((await readSession(root, session.id)).modules).toHaveLength(2);
	});

	it('refuses on a session that was already delivered', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(
			root,
			recordingDriver({ instruction: '', prompt: '' }),
		);
		const call = api(runtime);
		const session = await twoModuleSession(root);
		await updateSession(root, session.id, { ejectedAt: Date.now() });

		const delivered = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/modules`,
			{ body: { moduleId: 'expenses.core' } },
		);
		expect(delivered.status).toBe(409);
		expect(
			((await delivered.json()) as { error: { code: string } }).error.code,
		).toBe('SESSION_DELIVERED');
		expect((await readSession(root, session.id)).modules).toHaveLength(2);
	});
});

describe('a turn targets one module', () => {
	it('works in the module the request names and may only write there', async () => {
		const root = await workspace();
		const sink = { instruction: '', prompt: '' };
		const context = turnContext(root, recordingDriver(sink));
		const session = await twoModuleSession(root);

		await drive(context, session.id, {
			message: 'Show the VAT field on the catalog screen.',
			module: 'catalog',
		});

		expect(sink.instruction).toContain('Target module: catalog.core');
		expect(sink.instruction).toContain(
			'Module directory in this workspace: modules/catalog',
		);
		expect(sink.instruction).toContain('modules/catalog/src');
		expect(sink.instruction).not.toContain('modules/parties/src');
		/* The session context still names every module of the work. */
		expect(sink.instruction).toContain('parties.core (modules/parties');
		expect(sink.instruction).toContain('catalog.core (modules/catalog');

		const chat = await readChat(root, await readSession(root, session.id));
		expect(chat.find((entry) => entry.kind === 'user')?.module).toBe('catalog');
	});

	it('defaults to the primary module and keeps the handoff module afterwards', async () => {
		const root = await workspace();
		const sink = { instruction: '', prompt: '' };
		const context = turnContext(root, recordingDriver(sink));
		const session = await twoModuleSession(root);

		const first = await drive(context, session.id, { message: 'Start here.' });
		expect(sink.instruction).toContain('Target module: parties.core');
		expect(first.handoff.module).toBe('parties');

		await drive(context, session.id, {
			message: 'Now the screen.',
			module: 'catalog',
		});
		expect(sink.instruction).toContain('Target module: catalog.core');

		/* No module named: the last handoff decides, so the work stays where the
		   previous turn left it. */
		await drive(context, session.id, { message: 'Keep going.' });
		expect(sink.instruction).toContain('Target module: catalog.core');
	});

	it('refuses a module the session does not have', async () => {
		const root = await workspace();
		const context = turnContext(
			root,
			recordingDriver({ instruction: '', prompt: '' }),
		);
		const session = await twoModuleSession(root);
		await expect(
			drive(context, session.id, {
				message: 'Change the expenses module.',
				module: 'expenses',
			}),
		).rejects.toThrow(/has no module expenses/);
	});
});

describe('gates after a turn', () => {
	it('run for the modules that changed and name the module they ran in', async () => {
		const root = await workspace();
		const context = turnContext(
			root,
			recordingDriver(
				{ instruction: '', prompt: '' },
				{ file: 'modules/catalog/src/domain/vat.ts' },
			),
		);
		const session = await twoModuleSession(root);
		const outcome = await drive(context, session.id, {
			message: 'Show the VAT field.',
			module: 'catalog',
		});

		expect(outcome.diffs.map((diff) => diff.module)).toEqual(['catalog']);
		const modules = outcome.gates
			.map((gate) => gate.module)
			.filter((module): module is string => Boolean(module));
		expect(modules.length).toBeGreaterThan(0);
		expect([...new Set(modules)]).toEqual(['catalog']);
		expect(
			outcome.gates.some(
				(gate) => gate.id === 'dependencies' && gate.module === 'catalog',
			),
		).toBe(true);
	});
});

describe('delivering a session that spans modules', () => {
	const recording = () => {
		const calls: string[] = [];
		const commands: CommandRunner = async (_command, args) => {
			const step = args.includes('install')
				? 'install'
				: args.includes('enable')
					? 'enable'
					: args.includes('sync-scopes')
						? 'scopes'
						: 'verify';
			calls.push(step);
			return { code: 0, output: '' };
		};
		return { calls, commands };
	};

	const contextFor = (
		root: string,
		session: SandboxSession,
		commands: CommandRunner,
	): DeliveryContext => ({
		workspaceRoot: root,
		session,
		capabilities: ['sandbox.access.use', 'sandbox.modules.eject'],
		platformUrl: 'http://127.0.0.1:4310',
		runGates: async () => [],
		commands,
	});

	it('plans both modules and applies them in one delivery', async () => {
		const root = await workspace();
		const session = await twoModuleSession(root);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await writeFile(
			join(paths.workspace, 'modules', 'parties', 'src', 'vat.ts'),
			'export const vat = 1;\n',
			'utf8',
		);
		await writeFile(
			join(paths.workspace, 'modules', 'catalog', 'src', 'index.ts'),
			'export const catalog = 2;\n',
			'utf8',
		);
		const approvedModules = await Promise.all(
			session.modules.map(async (module) => {
				const spec = [
					`id: ${module.id}`,
					`name: ${module.directory}`,
					'description: Session delivery fixture',
					'specVersion: 0.1.0',
					'status: approved',
					'acceptanceScenarios:',
					`  - id: ${module.directory.toUpperCase()}-CHANGE`,
					'    given: a draft module',
					'    when: the requested change is delivered',
					'    then: the module change is available',
					'',
				].join('\n');
				const specPath = join(
					paths.workspace,
					'modules',
					module.directory,
					'spec',
					'module.yaml',
				);
				await mkdir(join(specPath, '..'), { recursive: true });
				await writeFile(specPath, spec, 'utf8');
				return {
					...module,
					specHash: hashSpec(spec),
					specApprovedAt: Date.now(),
				};
			}),
		);
		const approved = await updateSession(root, session.id, {
			modules: approvedModules,
		});

		const target = createLocalDeliveryTarget();
		const { calls, commands } = recording();
		const context = contextFor(root, approved, commands);
		const plan = await target.plan(context);
		expect(plan.modules.map((module) => module.id)).toEqual([
			'parties.core',
			'catalog.core',
		]);
		expect(plan.modules[0]!.additions).toContain('src/vat.ts');
		expect(plan.modules[1]!.overwrites).toContain('src/index.ts');
		expect(plan.modules.every((module) => module.enable)).toBe(false);

		const outcome = await target.apply(context, plan, () => undefined);
		expect(outcome.files).toBe(
			plan.modules.reduce((total, module) => total + module.files.length, 0),
		);
		expect(
			await readFile(join(root, 'modules/parties/src/vat.ts'), 'utf8'),
		).toBe('export const vat = 1;\n');
		expect(
			await readFile(join(root, 'modules/catalog/src/index.ts'), 'utf8'),
		).toBe('export const catalog = 2;\n');
		/* One install, one scope sync per module, one platform typecheck. */
		expect(calls).toEqual(['install', 'scopes', 'scopes', 'verify']);
		await expect(
			stat(join(root, 'modules/expenses/src/index.ts')),
		).resolves.toBeDefined();
	});
});
