import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToString } from 'octane/server';
import { createRouter } from '@octanejs/app-core';
import {
	DEFAULT_AGENT_ROLES,
	createCodingAgentRegistry,
	type CodingAgentDriver,
	type CodingAgentTurnRequest,
} from '@flowdular/coding-agent';
import { DEFAULT_CONFIGURATION } from '../src/server/config.ts';
import { routeRole } from '../src/server/planning.ts';
import type { PreviewRuntime } from '../src/server/preview-runtime.ts';
import { QUESTIONS_LIMITS } from '../src/server/questions.ts';
import {
	createSandboxRoutes,
	type SandboxRouteOptions,
} from '../src/server/routes.ts';
import type { SandboxRuntime } from '../src/server/runtime.ts';
import {
	approveSpecification,
	createSession,
	modulePathOf,
	readChat,
	readSession,
	sessionPaths,
	type HandoffPlan,
	type SandboxSession,
} from '../src/server/sessions.ts';
import { hashSpec, isSpecApproved } from '../src/server/spec.ts';
import { PendingQuestionsCard } from '../src/client/PendingQuestionsCard.tsrx';
import {
	registerSandboxTranslations,
	setActiveLocale,
} from '../src/client/i18n.ts';

/* The approved specification of the reported session, cut to what the
   question is about: it says what reinstating an item in use does, and nothing
   about reinstating one in repair. */
const APPROVED_SPEC = `schemaVersion: 2
id: equipment.core
specVersion: 0.1.0
status: approved
name: Equipment Register
description: Tenant-scoped register of equipment items.
permissions:
  - id: equipment.items.read
    description: List and open equipment items.
  - id: equipment.items.retire
    description: Retire and reinstate equipment items.
invariants:
  - Retiring an item that is already retired, or reinstating one that is already in use, answers the current item unchanged.
`;

/* The delta the business manager writes for the decision: a new error code is
   a change to what the module must do, so the document goes back to draft. */
const CHANGED_SPEC = APPROVED_SPEC.replace(
	'status: approved',
	'status: draft',
).concat(
	'  - Reinstating an item that is in repair is refused with 409 ITEM_NOT_RETIRED and changes nothing.\n',
);

const GAP = {
	id: 'Q-1',
	question:
		'The specification does not say what reinstating an item that is in repair does. What should it do?',
	options: ['Refuse with 409 ITEM_NOT_RETIRED', 'Answer the item unchanged'],
	recommended: 'Refuse with 409 ITEM_NOT_RETIRED',
	allowFreeText: true,
};

const READING = {
	id: 'Q-1',
	question:
		'Does reinstating an item that is already in use answer the item unchanged?',
	options: ['Yes, as the specification says', 'No, refuse it'],
	recommended: 'Yes, as the specification says',
	allowFreeText: false,
};

function asks(question: unknown): string {
	return [
		'The server is built against the approved specification. One behaviour it does not decide is left unbuilt.',
		'',
		'```questions',
		JSON.stringify({ questions: [question] }),
		'```',
		'',
		'HANDOFF: none - waiting for the decision',
	].join('\n');
}

const DONE = 'Done.\n\nHANDOFF: none - done';

type Reply = (request: CodingAgentTurnRequest) => Promise<string> | string;

/* One fake coding agent for the whole session: each turn takes the next
   reply, and every request is kept so the test can read who ran and what it
   was told. */
function scripted(
	replies: readonly Reply[],
	seen: CodingAgentTurnRequest[],
): CodingAgentDriver {
	return {
		id: 'fake',
		label: 'Fake',
		kind: 'byok',
		requiresLoopback: false,
		description: 'test driver',
		probe: async () => ({ available: true, detail: 'ok', version: '1' }),
		async *run(request: CodingAgentTurnRequest) {
			seen.push(request);
			const reply = replies[seen.length - 1] ?? (() => DONE);
			const text = await reply(request);
			yield {
				type: 'turn.started' as const,
				driver: 'fake',
				role: request.role,
				resumeId: null,
			};
			yield { type: 'assistant.message' as const, text };
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

function writesSpec(text: string, reply: string): Reply {
	return async (request) => {
		await writeFile(
			join(
				request.workspacePath,
				'modules',
				'equipment',
				'spec',
				'module.yaml',
			),
			text,
			'utf8',
		);
		return reply;
	};
}

function writes(files: Readonly<Record<string, string>>, reply: string): Reply {
	return async (request) => {
		for (const [path, text] of Object.entries(files)) {
			const target = join(request.workspacePath, 'modules', 'equipment', path);
			await mkdir(join(target, '..'), { recursive: true });
			await writeFile(target, text, 'utf8');
		}
		return reply;
	};
}

/* A server file the specialist leaves failing typecheck while it waits for
   the answers, and its fix. */
const SERVER_FILE = 'src/server/items.ts';
const BROKEN_SERVER = "export const limit: number = 'broken';\n";
const FIXED_SERVER = 'export const limit = 10;\n';

const preview: PreviewRuntime = {
	compose: () => Promise.reject(new Error('no preview in tests')),
	cached: () => null,
	forget: () => undefined,
	dispose: () => undefined,
};

function fakeRuntime(root: string, driver: CodingAgentDriver): SandboxRuntime {
	const configuration = {
		...DEFAULT_CONFIGURATION,
		mode: 'loopback' as const,
		driver: driver.id,
	};
	const connection = {
		connected: true,
		authority: {
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
		},
		error: null,
	};
	return {
		workspaceRoot: root,
		configuration: () => configuration,
		registry: () =>
			createCodingAgentRegistry({ mode: 'loopback', drivers: [driver] }),
		roles: () => DEFAULT_AGENT_ROLES,
		platform: () => null,
		connection: () => connection,
		aiEnvironment: () => null,
		decisions: () => null,
		refresh: async () => connection,
		update: async () => connection,
		openBrowserSession: async () => {
			throw new Error('not used');
		},
		browserSession: () => null,
		closeBrowserSession: () => undefined,
	};
}

type Gates = NonNullable<SandboxRouteOptions['executeGates']>;

const PASSING: Gates = async ({ gates }) =>
	gates.map((id) => ({
		id,
		status: 'passed' as const,
		durationMs: 0,
		command: id,
		output: 'valid',
	}));

/* Every gate passes but one, which fails with the output given while the
   session's copy of the module file still reads as broken. */
function failingUntilFixed(
	root: string,
	failing: string,
	file: string,
	broken: (text: string) => boolean,
	output: string,
): Gates {
	return async ({ session, gates }) => {
		const text = await readFile(
			join(
				modulePathOf(
					sessionPaths(root, session.id, session.moduleSuffix),
					'equipment',
				),
				file,
			),
			'utf8',
		).catch(() => '');
		return gates.map((id) => {
			const failed = id === failing && broken(text);
			return {
				id,
				module: 'equipment',
				status: failed ? ('failed' as const) : ('passed' as const),
				durationMs: 0,
				command: id,
				output: failed ? output : 'valid',
			};
		});
	};
}

function api(root: string, driver: CodingAgentDriver, gates = PASSING) {
	const router = createRouter([
		...createSandboxRoutes(fakeRuntime(root, driver), preview, {
			port: 4320,
			installDependencies: async () => ({
				ran: false,
				ok: true,
				durationMs: 0,
				output: '',
			}),
			executeGates: gates,
		}),
	]);
	/* Every call reads the whole response, so a turn stream has finished its
	   chain before the next call starts. */
	return async (path: string, body?: unknown): Promise<unknown> => {
		const url = new URL(path, 'http://127.0.0.1:4320');
		const method = body === undefined ? 'GET' : 'POST';
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
		if (!match || match.route.type !== 'server') throw new Error(path);
		const response = await match.route.handler({
			request,
			params: match.params,
			url,
			state: new Map(),
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`${response.status} ${text}`);
		return response.headers.get('content-type')?.includes('json')
			? (JSON.parse(text) as unknown)
			: text;
	};
}

async function approvedSession(root: string): Promise<SandboxSession> {
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
		'utf8',
	);
	await mkdir(join(root, 'modules', 'equipment', 'spec'), { recursive: true });
	await writeFile(
		join(root, 'modules', 'equipment', 'module.json'),
		`${JSON.stringify({ id: 'equipment.core' }, null, '\t')}\n`,
		'utf8',
	);
	await writeFile(
		join(root, 'modules', 'equipment', 'spec', 'module.yaml'),
		APPROVED_SPEC,
		'utf8',
	);
	const session = await createSession({
		workspaceRoot: root,
		kind: 'edit-module',
		moduleId: 'equipment.core',
		title: 'Equipment',
		brief:
			'Equipment register: staff edit items, managers retire and reinstate them.',
		blueprint: 'edit-module@1.0.0',
		role: 'backend-engineer',
		driver: 'fake',
		install: false,
	});
	return (await approveSpecification(root, session)).session;
}

async function specText(
	root: string,
	session: SandboxSession,
): Promise<string> {
	const paths = sessionPaths(root, session.id, session.moduleSuffix);
	return readFile(
		join(modulePathOf(paths, 'equipment'), 'spec', 'module.yaml'),
		'utf8',
	);
}

async function lastHandoff(
	root: string,
	session: SandboxSession,
): Promise<HandoffPlan> {
	return (await readChat(root, session))
		.filter((entry) => entry.handoff)
		.at(-1)!.handoff!;
}

async function implementerAsks(
	root: string,
	call: ReturnType<typeof api>,
): Promise<SandboxSession> {
	const session = await approvedSession(root);
	await call(`/sandbox/api/sessions/${session.id}/turn`, {
		message: 'Implement the approved specification.',
		role: 'backend-engineer',
	});
	return readSession(root, session.id);
}

describe('a question an implementer asks after approval', () => {
	it('waits for the answers in a card, and the specialist continues without a new approval when the specification already decides them', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-impl-questions-'));
		const seen: CodingAgentTurnRequest[] = [];
		const call = api(
			root,
			scripted(
				[
					() => asks(READING),
					() =>
						'The approved invariant already says this; the specification stays as it is.\n\nHANDOFF: backend-engineer - continue',
					() => DONE,
				],
				seen,
			),
		);

		const asked = await implementerAsks(root, call);
		expect(asked.state).toBe('awaiting-answers');
		expect(asked.pendingQuestions).toMatchObject({
			role: 'backend-engineer',
			module: 'equipment',
			questions: [{ id: 'Q-1' }],
		});
		expect(await lastHandoff(root, asked)).toMatchObject({
			kind: 'question',
			role: 'backend-engineer',
		});

		await call(`/sandbox/api/sessions/${asked.id}/answers`, {
			answers: [{ id: 'Q-1', answer: 'Yes, as the specification says' }],
		});

		expect(seen.map((request) => request.role)).toEqual([
			'backend-engineer',
			'business-manager',
			'backend-engineer',
		]);
		expect(seen[1]!.prompt).toContain(
			'- Q-1: Does reinstating an item that is already in use answer the item unchanged? -> Yes, as the specification says',
		);
		expect(seen[2]!.prompt).toContain('-> Yes, as the specification says');
		expect(seen[2]!.prompt).toContain('did not change');
		const after = await readSession(root, asked.id);
		expect(after.pendingQuestions).toBeNull();
		expect(after.state).not.toBe('awaiting-approval');
		expect(isSpecApproved(after.modules[0]!, await specText(root, after))).toBe(
			true,
		);
	});

	it('returns a specification the answers change to draft for approval, refuses implementation until then, and resumes the specialist that asked', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-impl-questions-'));
		const seen: CodingAgentTurnRequest[] = [];
		const call = api(
			root,
			scripted(
				[
					() => asks(GAP),
					writesSpec(
						CHANGED_SPEC,
						'The specification now refuses reinstating an item in repair with 409 ITEM_NOT_RETIRED.\n\nHANDOFF: backend-engineer - implement the new invariant after approval',
					),
					() => DONE,
				],
				seen,
			),
		);

		const asked = await implementerAsks(root, call);
		expect(asked.state).toBe('awaiting-answers');

		await call(`/sandbox/api/sessions/${asked.id}/answers`, {
			answers: [{ id: 'Q-1', answer: 'Refuse with 409 ITEM_NOT_RETIRED' }],
		});

		expect(seen.map((request) => request.role)).toEqual([
			'backend-engineer',
			'business-manager',
		]);
		expect(seen[1]!.systemInstruction).toContain(
			'These decisions answer questions Backend engineer asked',
		);
		const waiting = await readSession(root, asked.id);
		expect(waiting.state).toBe('awaiting-approval');
		const text = await specText(root, waiting);
		expect(text).toContain('status: draft');
		expect(isSpecApproved(waiting.modules[0]!, text)).toBe(false);
		const approval = await lastHandoff(root, waiting);
		expect(approval).toMatchObject({
			kind: 'approval',
			role: 'backend-engineer',
			module: 'equipment',
		});

		/* Nobody implements the changed text before the operator approves it. */
		await call(`/sandbox/api/sessions/${asked.id}/turn`, {
			message: 'Carry on with the server.',
			role: 'backend-engineer',
		});
		expect(seen).toHaveLength(2);

		await call(`/sandbox/api/sessions/${asked.id}/approve`, {
			module: 'equipment',
			specHash: hashSpec(text),
		});
		await call(`/sandbox/api/sessions/${asked.id}/turn`, {
			message: approval.prompt,
			role: approval.role,
			module: approval.module,
		});

		expect(seen.map((request) => request.role)).toEqual([
			'backend-engineer',
			'business-manager',
			'backend-engineer',
		]);
		expect(seen[2]!.prompt).toContain('-> Refuse with 409 ITEM_NOT_RETIRED');
		expect(seen[2]!.prompt).toContain(
			'The specification now records these decisions',
		);
	});

	it('keeps the specialist waiting while the business manager asks a question of its own', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-impl-questions-'));
		const seen: CodingAgentTurnRequest[] = [];
		const message = {
			id: 'Q-1',
			question: 'Should the refusal name the item status in its message?',
			options: ['Yes', 'No'],
			allowFreeText: false,
		};
		const call = api(
			root,
			scripted(
				[
					() => asks(GAP),
					() => asks(message),
					writesSpec(CHANGED_SPEC, 'Recorded.\n\nHANDOFF: none - recorded'),
				],
				seen,
			),
		);

		const asked = await implementerAsks(root, call);
		await call(`/sandbox/api/sessions/${asked.id}/answers`, {
			answers: [{ id: 'Q-1', answer: 'Refuse with 409 ITEM_NOT_RETIRED' }],
		});
		const owner = await readSession(root, asked.id);
		expect(owner.pendingQuestions?.role).toBe('business-manager');

		await call(`/sandbox/api/sessions/${asked.id}/answers`, {
			answers: [{ id: 'Q-1', answer: 'Yes' }],
		});

		expect(seen.map((request) => request.role)).toEqual([
			'backend-engineer',
			'business-manager',
			'business-manager',
		]);
		const approval = await lastHandoff(root, owner);
		expect(approval).toMatchObject({
			kind: 'approval',
			role: 'backend-engineer',
		});
		/* The implementer resumes with the answers to its own questions. */
		expect(approval.prompt).toContain('-> Refuse with 409 ITEM_NOT_RETIRED');
	});

	describe('when a gate the specialist left failing fails on the business manager turn too', () => {
		const typecheck = (root: string) =>
			failingUntilFixed(
				root,
				'typecheck',
				SERVER_FILE,
				(text) => text.includes('broken'),
				"src/server/items.ts(1,30): error TS2322: Type 'string' is not assignable to type 'number'.",
			);

		it('resumes the specialist with the decisions in its instruction, and the gate runs again after it', async () => {
			const root = await mkdtemp(join(tmpdir(), 'flowdular-impl-questions-'));
			const seen: CodingAgentTurnRequest[] = [];
			const call = api(
				root,
				scripted(
					[
						writes({ [SERVER_FILE]: BROKEN_SERVER }, asks(READING)),
						() =>
							'The approved invariant already says this; the specification stays as it is.\n\nHANDOFF: backend-engineer - continue',
						writes({ [SERVER_FILE]: FIXED_SERVER }, DONE),
					],
					seen,
				),
				typecheck(root),
			);

			const asked = await implementerAsks(root, call);
			expect(asked.failingGates).toEqual([
				{ id: 'typecheck', module: 'equipment' },
			]);
			await call(`/sandbox/api/sessions/${asked.id}/answers`, {
				answers: [{ id: 'Q-1', answer: 'Yes, as the specification says' }],
			});

			expect(seen.map((request) => request.role)).toEqual([
				'backend-engineer',
				'business-manager',
				'backend-engineer',
			]);
			expect(seen[2]!.prompt).toContain('-> Yes, as the specification says');
			expect(seen[2]!.prompt).toContain('did not change');
			const resumed = (await readChat(root, asked))
				.filter((entry) => entry.handoff)
				.at(1)!.handoff!;
			expect(resumed).toMatchObject({
				kind: 'continue',
				role: 'backend-engineer',
			});
			expect(resumed.repair).toBeUndefined();
			expect(resumed.reason).toContain(
				'The typecheck (modules/equipment) gate failed: the gates run again after Backend engineer continues',
			);
			expect((await readSession(root, asked.id)).failingGates).toEqual([]);
		});

		it('returns a changed specification for approval with the decisions, and the specialist resumes with them', async () => {
			const root = await mkdtemp(join(tmpdir(), 'flowdular-impl-questions-'));
			const seen: CodingAgentTurnRequest[] = [];
			const call = api(
				root,
				scripted(
					[
						writes({ [SERVER_FILE]: BROKEN_SERVER }, asks(GAP)),
						writesSpec(
							CHANGED_SPEC,
							'The specification now refuses reinstating an item in repair with 409 ITEM_NOT_RETIRED.\n\nHANDOFF: backend-engineer - implement the new invariant after approval',
						),
						writes({ [SERVER_FILE]: FIXED_SERVER }, DONE),
					],
					seen,
				),
				typecheck(root),
			);

			const asked = await implementerAsks(root, call);
			await call(`/sandbox/api/sessions/${asked.id}/answers`, {
				answers: [{ id: 'Q-1', answer: 'Refuse with 409 ITEM_NOT_RETIRED' }],
			});

			const waiting = await readSession(root, asked.id);
			expect(waiting.state).toBe('awaiting-approval');
			const approval = await lastHandoff(root, waiting);
			expect(approval).toMatchObject({
				kind: 'approval',
				role: 'backend-engineer',
				module: 'equipment',
			});
			expect(approval.prompt).toContain('-> Refuse with 409 ITEM_NOT_RETIRED');
			/* "Approve it" follows the reason, so the reason ends on the
			   specification. */
			expect(approval.reason).toMatch(
				/^The typecheck \(modules\/equipment\) gate failed: .* is ready for your review\.$/,
			);

			await call(`/sandbox/api/sessions/${asked.id}/approve`, {
				module: 'equipment',
				specHash: hashSpec(await specText(root, waiting)),
			});
			await call(`/sandbox/api/sessions/${asked.id}/turn`, {
				message: approval.prompt,
				role: approval.role,
				module: approval.module,
			});

			expect(seen.map((request) => request.role)).toEqual([
				'backend-engineer',
				'business-manager',
				'backend-engineer',
			]);
			expect(seen[2]!.prompt).toContain('-> Refuse with 409 ITEM_NOT_RETIRED');
			expect(seen[2]!.prompt).toContain(
				'The specification now records these decisions',
			);
		});

		it('lets the business manager repair its own files first, then resumes the specialist with the decisions', async () => {
			const root = await mkdtemp(join(tmpdir(), 'flowdular-impl-questions-'));
			const seen: CodingAgentTurnRequest[] = [];
			const call = api(
				root,
				scripted(
					[
						writes({ [SERVER_FILE]: FIXED_SERVER }, asks(READING)),
						() =>
							'The approved invariant already says this; the specification stays as it is.\n\nHANDOFF: backend-engineer - continue',
						writes(
							{
								'translations/en.json': '{"page.title":"Equipment"}\n',
							},
							'Added the missing copy.\n\nHANDOFF: backend-engineer - continue',
						),
						() => DONE,
					],
					seen,
				),
				failingUntilFixed(
					root,
					'module-schema',
					'translations/en.json',
					(text) => !text.includes('page.title'),
					'translations/en.json:1 has no page.title key the client uses.',
				),
			);

			const asked = await implementerAsks(root, call);
			await call(`/sandbox/api/sessions/${asked.id}/answers`, {
				answers: [{ id: 'Q-1', answer: 'Yes, as the specification says' }],
			});

			expect(seen.map((request) => request.role)).toEqual([
				'backend-engineer',
				'business-manager',
				'business-manager',
				'backend-engineer',
			]);
			expect(seen[3]!.prompt).toContain('-> Yes, as the specification says');
		});
	});

	it('sends a typed answer to the business manager too', () => {
		const session = { id: 's', modules: [] } as unknown as SandboxSession;
		const asked = (role: string, roleName: string) =>
			routeRole({
				session,
				paths: sessionPaths('/tmp/workspace', 's', 'equipment'),
				roles: DEFAULT_AGENT_ROLES,
				message: 'Refuse it with a conflict.',
				hasSpec: true,
				hasManifest: true,
				hasServer: true,
				hasClient: true,
				specApproved: true,
				lastHandoff: {
					kind: 'question',
					role,
					roleName,
					reason: 'Needs a decision.',
					prompt: '',
				},
			});

		expect(asked('frontend-engineer', 'Frontend engineer')).toEqual({
			role: 'business-manager',
			reason:
				'Frontend engineer asked about something the approved specification does not decide, so Business manager applies your answers to it first.',
		});
		expect(asked('business-manager', 'Business manager').role).toBe(
			'business-manager',
		);
	});

	it('tells every implementing role to ask instead of deciding, with the limits the parser enforces', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-impl-questions-'));
		const seen: CodingAgentTurnRequest[] = [];
		const call = api(root, scripted([() => DONE], seen));
		const session = await approvedSession(root);

		for (const role of [
			'backend-engineer',
			'frontend-engineer',
			'ux-designer',
			'agentic-engineer',
		]) {
			await call(`/sandbox/api/sessions/${session.id}/turn`, {
				message: 'Implement the approved specification.',
				role,
			});
		}

		expect(seen).toHaveLength(4);
		for (const request of seen) {
			expect(request.systemInstruction).toContain(
				'Implement only the behaviour the approved specification states.',
			);
			expect(request.systemInstruction).toContain('a new error code');
			expect(request.systemInstruction).toContain(QUESTIONS_LIMITS);
		}
	});
});

describe('the answers card for an implementer', () => {
	function render(role: string, locale: 'en' | 'pl' = 'en'): string {
		registerSandboxTranslations();
		setActiveLocale(locale);
		const html = renderToString(PendingQuestionsCard, {
			pending: {
				sequence: 3,
				role,
				module: 'equipment',
				askedAt: 1,
				questions: [{ ...GAP, allowFreeText: false }],
			},
			loading: false,
			denied: false,
			busy: false,
			error: '',
			onSubmit: () => {},
		}).html;
		setActiveLocale('en');
		return html;
	}

	it('says the answers go into the specification first', () => {
		expect(render('backend-engineer')).toContain(
			'The answers go into the approved specification first',
		);
		expect(render('backend-engineer', 'pl')).toContain(
			'Odpowiedzi trafiają najpierw do zatwierdzonej specyfikacji',
		);
		expect(render('business-manager')).toContain(
			'The specialist continues with them.',
		);
	});
});
