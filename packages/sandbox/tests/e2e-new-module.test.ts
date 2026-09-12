import { afterAll, expect, it } from 'vitest';
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { createRouter } from '@octanejs/app-core';
import {
	DEFAULT_AGENT_ROLES,
	createCodingAgentRegistry,
	type CodingAgentDriver,
	type CodingAgentTurnRequest,
} from '@flowdular/coding-agent';
import { DEFAULT_CONFIGURATION } from '../src/server/config.ts';
import {
	createLocalDeliveryTarget,
	spawnCommand,
	type CommandRunner,
	type DeliveryContext,
} from '../src/server/delivery/index.ts';
import type { GateResult } from '../src/server/gates.ts';
import type { PreviewRuntime } from '../src/server/preview-runtime.ts';
import { createSandboxRoutes } from '../src/server/routes.ts';
import type { SandboxRuntime } from '../src/server/runtime.ts';
import { readSession, type SandboxSession } from '../src/server/sessions.ts';
import { runSessionGates, type TurnContext } from '../src/server/turns.ts';
import { reviewFixture } from './support/auto-review.ts';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

/* A workspace that resolves the live framework packages without being able to
   write into them: pnpm overrides point at the checkout with `link:`, so the
   session install, the typecheck and the tests run against the real code while
   every file this test creates stays inside the temporary directory. */
async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-e2e-'));
	roots.push(root);
	const host = JSON.parse(
		await readFile(join(repository, 'package.json'), 'utf8'),
	) as { readonly packageManager?: string };
	await writeFile(
		join(root, 'flowdular.json'),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				architectureVersion: '0.2.0',
				specs: { platformRoot: 'specs', moduleDirectory: 'spec' },
				modules: { roots: ['modules'], enabled: [] },
				locales: ['en', 'pl'],
			},
			null,
			'\t',
		)}\n`,
	);
	await writeFile(
		join(root, 'package.json'),
		`${JSON.stringify(
			{
				private: true,
				type: 'module',
				...(host.packageManager ? { packageManager: host.packageManager } : {}),
				/* The checkout CLI, run in place: the delivery steps invoke
				   `flowdular` without --root, so the script must not move the
				   working directory away from this workspace. */
				scripts: {
					flowdular: `node ${JSON.stringify(
						createRequire(
							join(repository, 'packages', 'cli', 'index.js'),
						).resolve('tsx/cli'),
					)} ${JSON.stringify(join(repository, 'packages', 'cli', 'src', 'index.ts'))}`,
				},
			},
			null,
			'\t',
		)}\n`,
	);
	for (const shared of ['tsconfig.base.json', '.prettierrc.json']) {
		await cp(join(repository, shared), join(root, shared));
	}
	/* The lockfile seeds the resolution so the offline install finds every
	   pinned package in the host store instead of reaching for the registry. */
	await cp(join(repository, 'pnpm-lock.yaml'), join(root, 'pnpm-lock.yaml'));
	const overrides: Record<string, string> = {};
	for (const group of ['packages', 'modules']) {
		for (const entry of await readdir(join(repository, group))) {
			const manifest = await readFile(
				join(repository, group, entry, 'package.json'),
				'utf8',
			).catch(() => null);
			const name = manifest
				? (JSON.parse(manifest) as { readonly name?: string }).name
				: null;
			if (name) overrides[name] = `link:${join(repository, group, entry)}`;
		}
	}
	const settings = parseDocument(
		await readFile(join(repository, 'pnpm-workspace.yaml'), 'utf8'),
	);
	settings.set('packages', ['modules/*']);
	settings.set('overrides', overrides);
	await writeFile(join(root, 'pnpm-workspace.yaml'), settings.toString());
	await mkdir(join(root, 'modules'));
	/* module enable writes the composition into a real platform application. */
	await mkdir(join(root, 'platform', 'src', 'generated'), { recursive: true });
	await writeFile(
		join(root, 'platform', 'package.json'),
		`${JSON.stringify(
			{ name: '@flowdular/platform', private: true, dependencies: {} },
			null,
			'\t',
		)}\n`,
	);
	/* The format gate runs the workspace's own Prettier, and Prettier resolves
	   the plugin the shared configuration names by walking up from the module
	   it formats. In a real workspace both sit in the root node_modules. */
	await mkdir(join(root, 'node_modules', '@tsrx'), { recursive: true });
	await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
	await symlink(
		createRequire(import.meta.url).resolve('prettier/bin/prettier.cjs'),
		join(root, 'node_modules', '.bin', 'prettier'),
	);
	await symlink(
		join(repository, 'node_modules', '@tsrx', 'prettier-plugin'),
		join(root, 'node_modules', '@tsrx', 'prettier-plugin'),
	);
	for (const skill of ['spec-interview', 'module-new', 'auto-review']) {
		await mkdir(join(root, '.ai', 'skills', skill), { recursive: true });
		await writeFile(
			join(root, '.ai', 'skills', skill, 'SKILL.md'),
			`# ${skill}\n\nFixture skill for the end-to-end test.\n`,
		);
	}
	return root;
}

function specFor(moduleId: string): string {
	return `schemaVersion: 1
id: ${moduleId}
specVersion: 0.1.0
status: draft
name: Booking
description: Tenant-owned meeting room reservations.
profile: full
capabilities: [api, database, client, translations]
dependencies: []
tenancy: required
locales: [en, pl]
invariants: [Every booking belongs to one tenant.]
permissions:
  - id: booking.items.read
    description: Read bookings.
  - id: booking.items.manage
    description: Manage bookings.
dataOwnership: [booking.core owns room reservations.]
acceptanceScenarios:
  - id: BOOKING-LIST
    given: A tenant has bookings.
    when: An authorized user lists them.
    then: Only their tenant bookings are returned.
`;
}

/* The turn the test is currently driving. The driver is registered before the
   session exists, so the test fills this in as the flow reaches each stage. */
interface Script {
	spec: { module: string; moduleId: string } | null;
	readonly skills: string[];
}

function scriptedDriver(script: Script): CodingAgentDriver {
	return {
		id: 'fake',
		label: 'Fake',
		kind: 'byok',
		requiresLoopback: false,
		description: 'test driver',
		probe: async () => ({ available: true, detail: 'ok', version: '1' }),
		async *run(request: CodingAgentTurnRequest) {
			/* The planner runs on the same driver and carries no task skill. */
			const skill = /reference\/skills\/([a-z-]+)\/SKILL\.md/.exec(
				request.systemInstruction,
			)?.[1];
			if (skill) script.skills.push(skill);
			yield {
				type: 'turn.started' as const,
				driver: 'fake',
				role: request.role,
				resumeId: null,
			};
			if (script.spec) {
				const path = join(
					request.workspacePath,
					'modules',
					script.spec.module,
					'spec',
					'module.yaml',
				);
				await mkdir(join(path, '..'), { recursive: true });
				await writeFile(path, specFor(script.spec.moduleId), 'utf8');
				yield {
					type: 'file.changed' as const,
					path: `modules/${script.spec.module}/spec/module.yaml`,
					change: 'created' as const,
				};
				script.spec = null;
			}
			yield {
				type: 'assistant.message' as const,
				text: 'The specification is ready for your approval.\n\nHANDOFF: none - awaiting approval',
			};
			yield {
				type: 'turn.completed' as const,
				resumeId: null,
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				costUsd: null,
				finishReason: 'stop' as const,
			};
		},
	};
}

const preview: PreviewRuntime = {
	compose: () => Promise.reject(new Error('no preview in tests')),
	cached: () => null,
	forget: () => undefined,
	dispose: () => undefined,
};

const CAPABILITIES = ['sandbox.access.use', 'sandbox.modules.eject'];

function fakeRuntime(root: string, driver: CodingAgentDriver): SandboxRuntime {
	const configuration = {
		...DEFAULT_CONFIGURATION,
		mode: 'loopback' as const,
		driver: driver.id,
	};
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
			capabilities: CAPABILITIES,
			expiresAt: null,
		},
	};
	const connection = { connected: true, authority, error: null };
	return {
		workspaceRoot: root,
		configuration: () => configuration,
		registry: () =>
			createCodingAgentRegistry({ mode: 'loopback', drivers: [driver] }),
		roles: () => DEFAULT_AGENT_ROLES,
		platform: () => null,
		connection: () => connection,
		refresh: async () => connection,
		update: async () => connection,
		openBrowserSession: async () => {
			throw new Error('not used');
		},
		browserSession: () => null,
		closeBrowserSession: () => undefined,
	};
}

function api(runtime: SandboxRuntime) {
	const router = createRouter([
		...createSandboxRoutes(runtime, preview, { port: 4320 }),
	]);
	return async (
		method: string,
		path: string,
		body?: unknown,
	): Promise<Response> => {
		const url = new URL(path, 'http://127.0.0.1:4320');
		const request = new Request(url, {
			method,
			headers: {
				host: '127.0.0.1:4320',
				...(body !== undefined
					? { 'content-type': 'application/json', 'x-flowdular-sandbox': '1' }
					: {}),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
		const match = router.match(method, url.pathname);
		if (!match || match.route.type !== 'server') {
			throw new Error(`no sandbox route for ${method} ${url.pathname}`);
		}
		return match.route.handler({
			request,
			params: match.params,
			url,
			state: new Map(),
		});
	};
}

async function drain(response: Response): Promise<void> {
	expect(response.headers.get('content-type')).toContain('text/event-stream');
	const text = await response.text();
	expect(text).toContain('event: ended');
}

async function json<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & {
		readonly error?: { readonly code: string; readonly message: string };
	};
	if (!response.ok) {
		throw new Error(
			`${response.status} ${value.error?.code}: ${value.error?.message}`,
		);
	}
	return value;
}

function failures(gates: readonly GateResult[]): string {
	return gates
		.filter((gate) => gate.status !== 'passed')
		.map((gate) => `${gate.id} ${gate.status}: ${gate.output}`)
		.join('\n\n');
}

/* Every gate the sandbox runs before a module may land, in delivery order. */
const GATE_IDS = [
	'spec-schema',
	'module-schema',
	'dependencies',
	'typecheck',
	'tests',
	'format',
] as const;

it('carries one brief from the planner to a delivered module', async () => {
	const root = await workspace();
	const script: Script = { spec: null, skills: [] };
	const runtime = fakeRuntime(root, scriptedDriver(script));
	const call = api(runtime);

	// 1. The brief becomes a new-module session with one draft module.
	const created = await json<{
		readonly session: SandboxSession;
		readonly plan: { readonly kind: string };
	}>(
		await call('POST', '/sandbox/api/sessions', {
			brief: 'Build a booking module so a team can reserve meeting rooms.',
			driver: 'fake',
		}),
	);
	expect(created.plan.kind).toBe('new-module');
	const session = created.session;
	const module = session.modules[0]!;
	expect(session.modules).toHaveLength(1);
	/* Each stage is driven explicitly, so the chain never starts a turn this
	   test did not ask for. */
	await json(
		await call('POST', `/sandbox/api/sessions/${session.id}/settings`, {
			autoContinue: false,
		}),
	);

	// 2. The business manager writes the specification. Until the operator
	//    approves it the turn runs the interview skill, not the implementation.
	script.spec = { module: module.directory, moduleId: module.id };
	await drain(
		await call('POST', `/sandbox/api/sessions/${session.id}/turn`, {
			message: 'Write the specification for this module.',
			role: 'business-manager',
			driver: 'fake',
		}),
	);
	const afterSpec = await readSession(root, session.id);
	expect(afterSpec.modules[0]!.specHash).toBeUndefined();

	// 3. The operator approves the exact text, which records its hash.
	const approved = await json<{
		readonly session: SandboxSession;
		readonly status: string;
	}>(
		await call('POST', `/sandbox/api/sessions/${session.id}/approve`, {
			module: module.directory,
		}),
	);
	expect(approved.status).toBe('approved');
	expect(approved.session.modules[0]!.specHash).toEqual(expect.any(String));

	// 4. The next turn scaffolds the module through the real CLI and installs
	//    the session workspace for real.
	await drain(
		await call('POST', `/sandbox/api/sessions/${session.id}/turn`, {
			message: 'Add the terminology for both locales now that this is agreed.',
			role: 'business-manager',
			driver: 'fake',
		}),
	);
	const view = await json<{
		readonly session: SandboxSession;
		readonly diffs: readonly { readonly path: string }[];
	}>(await call('GET', `/sandbox/api/sessions/${session.id}`));
	const modulePath = join(
		root,
		'.flowdular',
		'sandbox',
		'sessions',
		session.id,
		'workspace',
		'modules',
		module.directory,
	);
	const manifest = JSON.parse(
		await readFile(join(modulePath, 'module.json'), 'utf8'),
	) as { readonly id: string };
	expect(manifest.id).toBe(module.id);
	expect(view.diffs.length).toBeGreaterThan(5);
	/* The session installed for real, which is what lets the typecheck and the
	   test gates below run instead of reporting a missing binary. */
	for (const binary of ['tsrx-tsc', 'vitest']) {
		await expect(
			stat(join(modulePath, 'node_modules', '.bin', binary)),
		).resolves.toBeDefined();
	}
	/* The interview runs while the specification is unapproved; the approved
	   hash is what moves the session on to the implementation skill. */
	expect(script.skills).toEqual(['spec-interview', 'module-new']);

	// 5. Every gate runs for real against the scaffolded module.
	const checked = await json<{ readonly gates: readonly GateResult[] }>(
		await call('POST', `/sandbox/api/sessions/${session.id}/gates`, {
			gates: [...GATE_IDS],
		}),
	);
	expect(failures(checked.gates)).toBe('');
	expect([...new Set(checked.gates.map((gate) => gate.id))].sort()).toEqual(
		[...GATE_IDS].sort(),
	);

	// 6. A passing auto-review record, bound to this exact source revision.
	const current = await readSession(root, session.id);
	await reviewFixture(root, current);
	const review = await runSessionGates(
		{
			workspaceRoot: root,
			configuration: runtime.configuration(),
			registry: runtime.registry(),
			roles: runtime.roles(),
			platform: null,
		} satisfies TurnContext,
		current,
		['auto-review'],
	);
	expect(failures(review)).toBe('');

	// 7. Delivery into modules/ of this workspace. The gates run again through
	//    the target, and the module files land for real.
	const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
	/* `module enable` is pure work on this temporary workspace, so it runs the
	   real command runner and its result is read back off disk. The other three
	   act on things a throwaway workspace does not have: the workspace install
	   would resolve the whole checkout, `auth sync-scopes` is a runtime action
	   against a platform database, and the platform typecheck needs a composed
	   application. Those are recorded, and the exact invocation delivery would
	   run is asserted instead. */
	const commands: CommandRunner = async (command, args, cwd, options) => {
		calls.push({ command, args, cwd });
		return args.includes('enable')
			? spawnCommand(command, args, cwd, options)
			: { code: 0, output: '' };
	};
	const context: DeliveryContext = {
		workspaceRoot: root,
		session: current,
		capabilities: CAPABILITIES,
		platformUrl: 'http://127.0.0.1:4310',
		runGates: (gates) =>
			runSessionGates(
				{
					workspaceRoot: root,
					configuration: runtime.configuration(),
					registry: runtime.registry(),
					roles: runtime.roles(),
					platform: null,
				} satisfies TurnContext,
				current,
				gates,
			),
		commands,
	};
	const target = createLocalDeliveryTarget();
	const plan = await target.plan(context);
	expect(plan.moduleId).toBe(module.id);
	expect(plan.enable).toBe(true);

	const progress: string[] = [];
	const gated: GateResult[] = [];
	const outcome = await target.apply(context, plan, (event, payload) => {
		if (event === 'gate.completed') gated.push(payload as GateResult);
		else if (event.endsWith('.completed')) progress.push(event);
	});
	expect(failures(gated)).toBe('');
	expect(progress).toEqual([
		'copy.completed',
		'install.completed',
		'enable.completed',
		'scopes.completed',
		'verify.completed',
	]);
	expect(outcome.moduleId).toBe(module.id);
	expect(
		JSON.parse(
			await readFile(
				join(root, 'modules', module.directory, 'module.json'),
				'utf8',
			),
		),
	).toMatchObject({ id: module.id });
	expect(outcome.steps.map((step) => step.id)).toEqual([
		'install',
		'enable',
		'scopes',
		'verify',
	]);
	expect(outcome.steps.every((step) => step.ok)).toBe(true);
	expect(calls.map((entry) => entry.args.join(' '))).toEqual([
		`--dir ${root} install --silent`,
		`--dir ${root} --silent flowdular module enable ${module.id} --apply --json`,
		`--dir ${root} --silent flowdular auth sync-scopes --module ${module.id} --apply --json`,
		`--dir ${root} --filter @flowdular/platform typecheck`,
	]);
	/* module enable is the step that joins the module to the application, and it
	   ran for real: the workspace configuration and the composed platform both
	   carry the delivered module now. */
	expect(
		JSON.parse(await readFile(join(root, 'flowdular.json'), 'utf8')) as unknown,
	).toMatchObject({ modules: { enabled: [module.id] } });
	expect(
		JSON.parse(
			await readFile(join(root, 'platform', 'package.json'), 'utf8'),
		) as { readonly dependencies: Readonly<Record<string, string>> },
	).toMatchObject({
		dependencies: { [`@flowdular/module-${module.directory}`]: 'workspace:*' },
	});
	expect(
		await readFile(
			join(root, 'platform', 'src', 'generated', 'modules.server.ts'),
			'utf8',
		),
	).toContain(`@flowdular/module-${module.directory}`);
}, 180_000);
