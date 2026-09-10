import { REVIEW_RESPONSE, fixtureGates } from './support/auto-review.ts';
import { runGates } from '../src/server/gates.ts';
import { inspectAutoReview } from '../src/server/auto-review.ts';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRouter } from '@octanejs/app-core';
import {
	DEFAULT_AGENT_ROLES,
	createCodingAgentRegistry,
	type CodingAgentDriver,
	type CodingAgentTurnRequest,
} from '@flowdular/coding-agent';
import { DEFAULT_CONFIGURATION } from '../src/server/config.ts';
import { createLocalDeliveryTarget } from '../src/server/delivery/index.ts';
import type {
	CommandRunner,
	DeliveryContext,
} from '../src/server/delivery/index.ts';
import { routeRole } from '../src/server/planning.ts';
import type { PreviewRuntime } from '../src/server/preview-runtime.ts';
import { createSandboxRoutes } from '../src/server/routes.ts';
import type { SandboxRuntime } from '../src/server/runtime.ts';
import {
	createSession,
	approveSpecification,
	readChat,
	readSession,
	sessionPaths,
	type ChatEntry,
	type SandboxSession,
} from '../src/server/sessions.ts';
import { diffSpecs, parseModuleSpec } from '../src/server/spec.ts';
import type { ModuleSpecReview } from '../src/server/spec.ts';
import {
	runTurn,
	type TurnContext,
	type TurnOutcome,
} from '../src/server/turns.ts';

const BASE_SPEC = `schemaVersion: 1
id: parties.core
specVersion: 0.2.0
status: approved
name: Parties Core
description: Tenant-scoped customers and suppliers.
profile: full
capabilities:
  - api
  - database
dependencies:
  - id: system.core
    range: ^0.1.0
tenancy: required
locales:
  - en
invariants:
  - Every party is owned by exactly one tenant.
permissions:
  - id: parties.parties.read
    description: Read parties in the active tenant.
dataOwnership:
  - parties.core owns party identity and name.
acceptanceScenarios:
  - id: PARTIES-LIST
    given: Tenant-scoped parties exist.
    when: An authorized principal lists parties.
    then: Only parties of the active tenant are returned.
`;

/* The delta a business manager writes for a change: the version moves and the
   new behaviour is a scenario. */
const CHANGED_SPEC = BASE_SPEC.replace(
	'specVersion: 0.2.0',
	'specVersion: 0.3.0',
)
	.replace(
		'  - id: parties.parties.read\n    description: Read parties in the active tenant.\n',
		'  - id: parties.parties.read\n    description: Read parties in the active tenant.\n  - id: parties.parties.manage\n    description: Create and update parties in the active tenant.\n',
	)
	.concat(
		`  - id: PARTIES-VAT
    given: An authorized principal supplies a VAT number.
    when: The party is created.
    then: The VAT number is stored against the tenant-owned party.
`,
	);

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-spec-'));
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
		'utf8',
	);
	await writeFile(join(root, 'tsconfig.base.json'), '{}', 'utf8');
	await writeFile(join(root, '.prettierrc.json'), '{}', 'utf8');
	await mkdir(join(root, 'modules', 'parties', 'src'), { recursive: true });
	await mkdir(join(root, 'modules', 'parties', 'spec'), { recursive: true });
	await writeFile(
		join(root, 'modules', 'parties', 'module.json'),
		`${JSON.stringify({ id: 'parties.core' })}\n`,
		'utf8',
	);
	await writeFile(
		join(root, 'modules', 'parties', 'package.json'),
		`${JSON.stringify({ name: '@flowdular/module-parties' })}\n`,
		'utf8',
	);
	await writeFile(
		join(root, 'modules', 'parties', 'src', 'index.ts'),
		'export const parties = 1;\n',
		'utf8',
	);
	await writeFile(
		join(root, 'modules', 'parties', 'spec', 'module.yaml'),
		BASE_SPEC,
		'utf8',
	);
	return root;
}

function editSession(root: string): Promise<SandboxSession> {
	return createSession({
		workspaceRoot: root,
		kind: 'edit-module',
		moduleId: 'parties.core',
		title: 'VAT number',
		brief: 'Store a VAT number on a party.',
		blueprint: 'edit-module@1.0.0',
		role: 'business-manager',
		driver: 'fake',
		sourceModule: 'parties',
		install: false,
	});
}

/* Records what the driver was handed, so a refused turn is visible as a driver
   that never ran. */
function recordingDriver(
	sink: { prompt: string; role: string },
	options: {
		readonly file?: string;
		readonly content?: string;
		readonly closing?: string;
	} = {},
): CodingAgentDriver {
	return {
		id: 'fake',
		label: 'Fake',
		kind: 'byok',
		requiresLoopback: false,
		description: 'test driver',
		probe: async () => ({ available: true, detail: 'ok', version: '1' }),
		async *run(request: CodingAgentTurnRequest) {
			sink.prompt = request.prompt;
			sink.role = request.role;
			yield {
				type: 'turn.started',
				driver: 'fake',
				role: request.role,
				resumeId: null,
			};
			if (options.file) {
				const target = join(request.workspacePath, options.file);
				await mkdir(join(target, '..'), { recursive: true });
				await writeFile(target, options.content ?? `// ${request.role}\n`);
				yield { type: 'file.changed', path: options.file, change: 'created' };
			}
			yield {
				type: 'assistant.message',
				text: options.closing ?? 'Done.\n\nHANDOFF: none - done',
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
		executeGates: async ({ gates }) =>
			gates.map((id) => ({
				id,
				status: 'passed' as const,
				durationMs: 0,
				command: id,
				output: 'valid',
			})),
	};
}

async function drive(
	context: TurnContext,
	sessionId: string,
	input: { readonly message: string; readonly role?: string },
): Promise<TurnOutcome> {
	const iterator = runTurn(context, {
		sessionId,
		message: input.message,
		driver: 'fake',
		...(input.role ? { role: input.role } : {}),
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

function api(runtime: SandboxRuntime) {
	const router = createRouter([
		...createSandboxRoutes(runtime, preview, { port: 4320 }),
	]);
	return async (
		method: string,
		path: string,
		init: { readonly body?: unknown } = {},
	): Promise<Response> => {
		const url = new URL(path, 'http://127.0.0.1:4320');
		const request = new Request(url, {
			method,
			headers: {
				host: '127.0.0.1:4320',
				...(init.body !== undefined
					? { 'content-type': 'application/json', 'x-flowdular-sandbox': '1' }
					: {}),
			},
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

function draftSpecPath(root: string, session: SandboxSession): string {
	return join(
		sessionPaths(root, session.id, session.moduleSuffix).workspace,
		'modules',
		'parties',
		'spec',
		'module.yaml',
	);
}

function refusal(chat: readonly ChatEntry[]): ChatEntry | undefined {
	return chat.find(
		(entry) =>
			entry.event?.type === 'error' && entry.event.code === 'SPEC_NOT_APPROVED',
	);
}

describe('the specification diff', () => {
	it('names the fields, scenarios and permissions a change adds', () => {
		const changes = diffSpecs(
			parseModuleSpec(BASE_SPEC),
			parseModuleSpec(CHANGED_SPEC),
		);
		expect(changes).toContainEqual({
			field: 'specVersion',
			kind: 'changed',
			key: null,
			before: '0.2.0',
			after: '0.3.0',
		});
		expect(changes).toContainEqual({
			field: 'permissions',
			kind: 'added',
			key: 'parties.parties.manage',
			before: null,
			after: 'Create and update parties in the active tenant.',
		});
		expect(
			changes.filter((change) => change.field === 'acceptanceScenarios'),
		).toEqual([
			{
				field: 'acceptanceScenarios',
				kind: 'added',
				key: 'PARTIES-VAT',
				before: null,
				after:
					'Given An authorized principal supplies a VAT number. When The party is created. Then The VAT number is stored against the tenant-owned party.',
			},
		]);
	});

	it('reports a removed sentence and a reworded scenario', () => {
		const reworded = BASE_SPEC.replace(
			'    then: Only parties of the active tenant are returned.',
			'    then: Only parties of the active tenant are returned, ordered by name.',
		).replace('  - Every party is owned by exactly one tenant.\n', '');
		const changes = diffSpecs(
			parseModuleSpec(BASE_SPEC),
			parseModuleSpec(reworded),
		);
		expect(changes).toContainEqual({
			field: 'invariants',
			kind: 'removed',
			key: 'Every party is owned by exactly one tenant.',
			before: 'Every party is owned by exactly one tenant.',
			after: null,
		});
		expect(
			changes.some(
				(change) =>
					change.field === 'acceptanceScenarios' &&
					change.kind === 'changed' &&
					change.key === 'PARTIES-LIST',
			),
		).toBe(true);
	});

	it('reports nothing when the document did not move', () => {
		expect(
			diffSpecs(parseModuleSpec(BASE_SPEC), parseModuleSpec(BASE_SPEC)),
		).toEqual([]);
	});
});

describe('routing a change session', () => {
	it('sends the turn to the business manager while the spec is unapproved', () => {
		const routed = routeRole({
			session: { kind: 'edit-module', role: 'backend-engineer' } as never,
			paths: sessionPaths('/tmp/workspace', 'x', 'parties') as never,
			roles: DEFAULT_AGENT_ROLES,
			message: 'Store a VAT number on a party.',
			hasSpec: true,
			hasManifest: true,
			hasServer: true,
			hasClient: true,
			specApproved: false,
		});
		expect(routed.role).toBe('business-manager');
		expect(routed.reason).toContain('not approved');
	});
});

describe('the specification gate of a change session', () => {
	it('refuses an implementer turn and routes back to the business manager', async () => {
		const root = await workspace();
		const sink = { prompt: '', role: '' };
		const context = turnContext(root, recordingDriver(sink));
		const session = await editSession(root);

		const outcome = await drive(context, session.id, {
			message: 'Add the VAT column.',
			role: 'backend-engineer',
		});

		expect(sink.prompt).toBe('');
		expect(outcome.handoff.kind).toBe('continue');
		expect(outcome.handoff.role).toBe('business-manager');
		expect(outcome.handoff.prompt).toContain('specVersion');
		const chat = await readChat(root, await readSession(root, session.id));
		expect(refusal(chat)?.text).toContain('not approved');
	});

	it('keeps implementation blocked when the specification owner role is missing', async () => {
		const root = await workspace();
		const sink = { prompt: '', role: '' };
		const context = {
			...turnContext(root, recordingDriver(sink)),
			roles: DEFAULT_AGENT_ROLES.filter(
				(role) => role.id !== 'business-manager',
			),
		};
		const session = await editSession(root);

		const outcome = await drive(context, session.id, {
			message: 'Add the VAT column.',
			role: 'backend-engineer',
		});

		expect(sink.prompt).toBe('');
		expect(outcome.handoff.kind).toBe('blocked');
		expect(outcome.handoff.role).toBe('backend-engineer');
		expect(outcome.handoff.reason).toContain('business-manager');
	});

	it('stops for the operator once the delta exists, and names the implementer', async () => {
		const root = await workspace();
		const sink = { prompt: '', role: '' };
		const context = turnContext(root, recordingDriver(sink));
		const session = await editSession(root);
		await writeFile(draftSpecPath(root, session), CHANGED_SPEC, 'utf8');

		const outcome = await drive(context, session.id, {
			message: 'Add the VAT column.',
			role: 'backend-engineer',
		});

		expect(sink.prompt).toBe('');
		expect(outcome.handoff.kind).toBe('approval');
		expect(outcome.handoff.role).toBe('backend-engineer');
		expect(outcome.session.state).toBe('awaiting-approval');
	});

	it('lets the business manager take the turn it was routed', async () => {
		const root = await workspace();
		const sink = { prompt: '', role: '' };
		const context = turnContext(root, recordingDriver(sink));
		const session = await editSession(root);

		await drive(context, session.id, { message: 'Store a VAT number.' });

		expect(sink.role).toBe('business-manager');
	});
});

describe('approving the specification of a change', () => {
	it('records the approved text and unblocks the implementer', async () => {
		const root = await workspace();
		const sink = { prompt: '', role: '' };
		const driver = recordingDriver(sink);
		const context = turnContext(root, driver);
		const call = api(fakeRuntime(root, driver));
		const session = await editSession(root);
		await writeFile(draftSpecPath(root, session), CHANGED_SPEC, 'utf8');

		const approved = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/approve`,
			{ body: { module: 'parties' } },
		);
		expect(approved.status).toBe(200);
		const record = await readSession(root, session.id);
		expect(record.modules[0]!.specHash).toMatch(/^[0-9a-f]{64}$/);
		expect(record.modules[0]!.specApprovedAt).toBeGreaterThan(0);

		await drive(context, session.id, {
			message: 'Add the VAT column.',
			role: 'backend-engineer',
		});
		expect(sink.role).toBe('backend-engineer');
		expect(sink.prompt).toContain('VAT');
	});

	it('re-opens the gate when the specification changes after the approval', async () => {
		const root = await workspace();
		const sink = { prompt: '', role: '' };
		const driver = recordingDriver(sink);
		const context = turnContext(root, driver);
		const call = api(fakeRuntime(root, driver));
		const session = await editSession(root);
		const specPath = draftSpecPath(root, session);
		await writeFile(specPath, CHANGED_SPEC, 'utf8');
		await call('POST', `/sandbox/api/sessions/${session.id}/approve`, {
			body: { module: 'parties' },
		});

		await writeFile(
			specPath,
			`${CHANGED_SPEC}  - id: PARTIES-EXTRA\n    given: A party exists.\n    when: It is archived.\n    then: It stops appearing in the list.\n`,
			'utf8',
		);

		const outcome = await drive(context, session.id, {
			message: 'Add the VAT column.',
			role: 'backend-engineer',
		});
		expect(sink.role).toBe('');
		expect(outcome.handoff.kind).toBe('approval');
	});

	it('serves the review the card renders, with the delta', async () => {
		const root = await workspace();
		const driver = recordingDriver({ prompt: '', role: '' });
		const call = api(fakeRuntime(root, driver));
		const session = await editSession(root);
		await writeFile(draftSpecPath(root, session), CHANGED_SPEC, 'utf8');

		const view = (await (
			await call('GET', `/sandbox/api/sessions/${session.id}`)
		).json()) as { specs: readonly ModuleSpecReview[] };
		const review = view.specs[0]!;
		expect(review.module).toBe('parties');
		expect(review.approved).toBe(false);
		expect(review.path).toBe('modules/parties/spec/module.yaml');
		expect(review.draft?.permissions).toHaveLength(2);
		expect(review.draft?.acceptanceScenarios.at(-1)?.id).toBe('PARTIES-VAT');
		expect(
			review.changes.some(
				(change) => change.field === 'specVersion' && change.after === '0.3.0',
			),
		).toBe(true);
	});
});

describe('the three answers to a review', () => {
	it('turns a requested change into a business manager turn carrying the comment', async () => {
		const root = await workspace();
		const driver = recordingDriver({ prompt: '', role: '' });
		const call = api(fakeRuntime(root, driver));
		const session = await editSession(root);

		const response = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/spec/changes`,
			{
				body: {
					module: 'parties',
					comment: 'The VAT number must be unique inside a tenant.',
				},
			},
		);
		expect(response.status).toBe(200);
		const asked = (await response.json()) as {
			handoff: { role: string; prompt: string; module: string };
		};
		expect(asked.handoff.role).toBe('business-manager');
		expect(asked.handoff.module).toBe('parties');
		expect(asked.handoff.prompt).toContain('unique inside a tenant');

		const chat = await readChat(root, await readSession(root, session.id));
		expect(
			chat.some(
				(entry) =>
					entry.kind === 'user' &&
					(entry.text ?? '').includes('unique inside a tenant'),
			),
		).toBe(true);
	});

	it('refuses a requested change with no comment', async () => {
		const root = await workspace();
		const call = api(
			fakeRuntime(root, recordingDriver({ prompt: '', role: '' })),
		);
		const session = await editSession(root);
		const response = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/spec/changes`,
			{ body: { module: 'parties', comment: '   ' } },
		);
		expect(response.status).toBe(400);
	});

	it('edits the specification in place and re-opens the gate', async () => {
		const root = await workspace();
		const driver = recordingDriver({ prompt: '', role: '' });
		const call = api(fakeRuntime(root, driver));
		const session = await editSession(root);
		await writeFile(draftSpecPath(root, session), CHANGED_SPEC, 'utf8');
		await call('POST', `/sandbox/api/sessions/${session.id}/approve`, {
			body: { module: 'parties' },
		});

		const read = (await (
			await call(
				'GET',
				`/sandbox/api/sessions/${session.id}/spec?module=parties`,
			)
		).json()) as { text: string; path: string };
		expect(read.path).toBe('modules/parties/spec/module.yaml');
		expect(read.text).toContain('specVersion: 0.3.0');

		const saved = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/spec`,
			{
				body: {
					module: 'parties',
					text: read.text.replace('specVersion: 0.3.0', 'specVersion: 0.4.0'),
				},
			},
		);
		expect(saved.status).toBe(200);
		const view = (await saved.json()) as { specs: readonly ModuleSpecReview[] };
		expect(view.specs[0]!.approved).toBe(false);
		expect(view.specs[0]!.draft?.specVersion).toBe('0.4.0');
		expect(await readFile(draftSpecPath(root, session), 'utf8')).toContain(
			'specVersion: 0.4.0',
		);
	});

	it('refuses a module the session does not hold', async () => {
		const root = await workspace();
		const call = api(
			fakeRuntime(root, recordingDriver({ prompt: '', role: '' })),
		);
		const session = await editSession(root);
		const response = await call(
			'GET',
			`/sandbox/api/sessions/${session.id}/spec?module=../../etc`,
		);
		expect(response.status).toBe(400);
		expect(
			((await response.json()) as { error: { code: string } }).error.code,
		).toBe('MODULE_NOT_IN_SESSION');
	});
});

describe('a new module session', () => {
	it('refuses an explicitly selected implementer before a specification exists', async () => {
		const root = await workspace();
		const sink = { prompt: '', role: '' };
		const context = turnContext(root, recordingDriver(sink));
		const session = await createSession({
			workspaceRoot: root,
			kind: 'new-module',
			moduleId: 'booking.core',
			title: 'Booking',
			brief: 'A module that books rooms.',
			blueprint: 'new-module@1.0.0',
			role: 'business-manager',
			driver: 'fake',
			install: false,
		});

		const outcome = await drive(context, session.id, {
			message: 'Build the server before writing the specification.',
			role: 'backend-engineer',
		});

		expect(sink.prompt).toBe('');
		expect(outcome.handoff.kind).toBe('continue');
		expect(outcome.handoff.role).toBe('business-manager');
		const chat = await readChat(root, await readSession(root, session.id));
		expect(refusal(chat)?.text).toContain('not approved');
	});

	it('still gates on the status line and scaffolds after the approval', async () => {
		const root = await workspace();
		const sink = { prompt: '', role: '' };
		const draftSpec = BASE_SPEC.replace('id: parties.core', 'id: booking.core')
			.replace('status: approved', 'status: draft')
			.replace('parties.parties.read', 'booking.bookings.read');
		const driver = recordingDriver(sink, {
			file: 'modules/booking/spec/module.yaml',
			content: draftSpec,
		});
		const context = turnContext(root, driver);
		const call = api(fakeRuntime(root, driver));
		const session = await createSession({
			workspaceRoot: root,
			kind: 'new-module',
			moduleId: 'booking.core',
			title: 'Booking',
			brief: 'A module that books rooms.',
			blueprint: 'new-module@1.0.0',
			role: 'business-manager',
			driver: 'fake',
			install: false,
		});
		/* A manifest of its own keeps the scaffold, which shells out to the CLI,
		   out of this test. */
		await writeFile(
			join(
				sessionPaths(root, session.id, session.moduleSuffix).workspace,
				'modules',
				'booking',
				'module.json',
			),
			`${JSON.stringify({ id: 'booking.core' })}\n`,
			'utf8',
		);

		const first = await drive(context, session.id, {
			message: 'A module that books rooms.',
		});
		expect(sink.role).toBe('business-manager');
		expect(first.handoff.kind).toBe('approval');

		await call('POST', `/sandbox/api/sessions/${session.id}/approve`, {
			body: {},
		});
		const specPath = join(
			sessionPaths(root, session.id, session.moduleSuffix).workspace,
			'modules',
			'booking',
			'spec',
			'module.yaml',
		);
		expect(await readFile(specPath, 'utf8')).toContain('status: approved');

		sink.role = '';
		await drive(context, session.id, {
			message: 'Build the server.',
			role: 'backend-engineer',
		});
		expect(sink.role).toBe('backend-engineer');
	});
});

describe('delivering a change', () => {
	const commands: CommandRunner = async () => ({ code: 0, output: '' });

	const contextFor = (
		root: string,
		session: SandboxSession,
	): DeliveryContext => ({
		workspaceRoot: root,
		session,
		capabilities: ['sandbox.access.use', 'sandbox.modules.eject'],
		platformUrl: 'http://127.0.0.1:4310',
		runGates: async () => [],
		commands,
	});

	const changedSession = async (spec?: string) => {
		const root = await workspace();
		const session = await editSession(root);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await writeFile(
			join(paths.workspace, 'modules', 'parties', 'src', 'vat.ts'),
			'export const vat = 1;\n',
			'utf8',
		);
		if (spec) await writeFile(draftSpecPath(root, session), spec, 'utf8');
		/* Delivery checks the same operator decision as a real eject. Approve the
		   exact fixture here so these tests reach the version/scenario guards. */
		const approved = await approveSpecification(root, session);
		return { root, session: approved.session };
	};

	it('refuses when the specification did not move with the change', async () => {
		const { root, session } = await changedSession();
		await expect(
			createLocalDeliveryTarget().plan(contextFor(root, session)),
		).rejects.toMatchObject({
			code: 'EJECT_SPEC_VERSION_UNCHANGED',
			message: expect.stringContaining('specVersion is unchanged'),
		});
	});

	it('refuses when the version moved but no scenario did', async () => {
		const { root, session } = await changedSession(
			BASE_SPEC.replace('specVersion: 0.2.0', 'specVersion: 0.3.0'),
		);
		await expect(
			createLocalDeliveryTarget().plan(contextFor(root, session)),
		).rejects.toMatchObject({
			code: 'EJECT_SPEC_SCENARIOS_UNCHANGED',
			message: expect.stringContaining('acceptance scenario'),
		});
	});

	it('delivers when the specification covers the change', async () => {
		const { root, session } = await changedSession(CHANGED_SPEC);
		const plan = await createLocalDeliveryTarget().plan(
			contextFor(root, session),
		);
		expect(plan.modules[0]!.additions).toContain('src/vat.ts');
	});

	it('says nothing about a module the session did not change', async () => {
		const root = await workspace();
		const session = await editSession(root);
		const approved = await approveSpecification(root, session);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await writeFile(
			join(paths.workspace, 'modules', 'parties', 'src', 'index.ts'),
			'export const parties = 1;\n',
			'utf8',
		);
		const plan = await createLocalDeliveryTarget().plan(
			contextFor(root, approved.session),
		);
		expect(plan.modules[0]!.additions).toEqual([]);
	});
});

describe('auto-review turn lifecycle', () => {
	async function setup() {
		const root = await workspace();
		for (const skill of ['auto-review', 'module-update']) {
			await mkdir(join(root, '.ai/skills', skill), { recursive: true });
			await writeFile(
				join(root, '.ai/skills', skill, 'SKILL.md'),
				'# Fixture skill',
			);
		}
		const session = await editSession(root);
		await writeFile(draftSpecPath(root, session), CHANGED_SPEC);
		const approved = (await approveSpecification(root, session)).session;
		return {
			root,
			session: approved,
			paths: sessionPaths(root, session.id, session.moduleSuffix),
		};
	}
	function context(root: string, driver: CodingAgentDriver): TurnContext {
		return {
			...turnContext(root, driver),
			executeGates: async ({ session, gates, modules }) => {
				const deterministic = fixtureGates(
					session,
					gates.filter((id) => id !== 'auto-review'),
				);
				if (!gates.includes('auto-review')) return deterministic;
				return [
					...deterministic,
					...(await runGates({
						workspaceRoot: root,
						paths: sessionPaths(root, session.id, session.moduleSuffix),
						session,
						gates: ['auto-review'],
						...(modules ? { modules } : {}),
					})),
				];
			},
		};
	}
	it('routes implementation to review and only records an unchanged review turn', async () => {
		const { root, session, paths } = await setup();
		const implemented = await drive(
			context(
				root,
				recordingDriver(
					{ prompt: '', role: '' },
					{ file: 'modules/parties/src/services/vat.ts' },
				),
			),
			session.id,
			{ message: 'Implement VAT', role: 'backend-engineer' },
		);
		expect(implemented.handoff.kind).toBe('continue');
		expect(implemented.handoff.prompt).toContain('$auto-review');
		const driver = recordingDriver(
			{ prompt: '', role: '' },
			{ closing: REVIEW_RESPONSE },
		);
		const checking: CodingAgentDriver = {
			...driver,
			async *run(request) {
				expect(request.allowedPaths).toEqual([]);
				expect(
					await readFile(
						join(
							request.workspacePath,
							'reference/auto-review-base/src/index.ts',
						),
						'utf8',
					),
				).toContain('parties = 1');
				expect(request.systemInstruction).toContain(
					'reference/skills/auto-review/SKILL.md',
				);
				yield* driver.run(request);
			},
		};
		const reviewed = await drive(context(root, checking), session.id, {
			message: implemented.handoff.prompt,
			role: 'backend-engineer',
		});
		expect(reviewed.gates.every((gate) => gate.status === 'passed')).toBe(true);
		expect((await inspectAutoReview(paths, session.modules[0]!)).passed).toBe(
			true,
		);
		await drive(
			context(
				root,
				recordingDriver(
					{ prompt: '', role: '' },
					{
						file: 'modules/parties/src/services/vat.ts',
						content: 'unauthorized review edit',
						closing: REVIEW_RESPONSE,
					},
				),
			),
			session.id,
			{ message: '$auto-review', role: 'backend-engineer' },
		);
		expect((await inspectAutoReview(paths, session.modules[0]!)).passed).toBe(
			false,
		);
		expect(
			await readFile(join(paths.modulePath, 'src/services/vat.ts'), 'utf8'),
		).not.toContain('unauthorized');
	});
	it('preserves an intermediate handoff before requiring final review', async () => {
		const { root, session } = await setup();
		const outcome = await drive(
			context(
				root,
				recordingDriver(
					{ prompt: '', role: '' },
					{
						file: 'modules/parties/src/services/vat.ts',
						closing: 'HANDOFF: frontend-engineer - implement the VAT field',
					},
				),
			),
			session.id,
			{ message: 'Implement VAT storage', role: 'backend-engineer' },
		);
		expect(outcome.handoff.role).toBe('frontend-engineer');
		expect(outcome.gates.some((gate) => gate.id === 'auto-review')).toBe(false);
	});
	it.each(['failed', 'skipped'] as const)(
		'does not persist a passing model report when tests are %s',
		async (status) => {
			const { root, session, paths } = await setup();
			const driver = recordingDriver(
				{ prompt: '', role: '' },
				{ closing: REVIEW_RESPONSE },
			);
			const original = context(root, driver);
			await drive(
				{
					...original,
					executeGates: async (input) =>
						(await original.executeGates!(input)).map((gate) =>
							gate.id === 'tests' ? { ...gate, status } : gate,
						),
				},
				session.id,
				{ message: '$auto-review', role: 'backend-engineer' },
			);
			expect((await inspectAutoReview(paths, session.modules[0]!)).passed).toBe(
				false,
			);
		},
	);
	it('returns findings to an implementation phase without issuing a pass', async () => {
		const { root, session, paths } = await setup();
		const result = await drive(
			context(
				root,
				recordingDriver(
					{ prompt: '', role: '' },
					{ closing: REVIEW_RESPONSE.replace('"pass"', '"fail"') },
				),
			),
			session.id,
			{ message: '$auto-review', role: 'backend-engineer' },
		);
		expect(result.handoff.kind).toBe('continue');
		expect(result.handoff.prompt).toContain('$module-update');
		expect(result.handoff.prompt).not.toContain('$auto-review');
		expect((await inspectAutoReview(paths, session.modules[0]!)).passed).toBe(
			false,
		);
	});
});
