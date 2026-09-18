import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
import {
	AgentHarness,
	type AgentProvider,
	type AgentTool,
} from '@flowdular/harness';
import {
	assistantAgentDefinition,
	ASSISTANT_AGENT_ID,
} from '../src/agent/assistant.ts';
import { AGENT_PERMISSIONS } from '../src/acl/permissions.ts';
import { AgentService } from '../src/services/agent-service.ts';
import {
	AssistantService,
	type AssistantMember,
} from '../src/services/assistant-service.ts';
import { AgentWorker } from '../src/services/worker.ts';
import { agentSettings, type AgentSettingsReader } from '../src/settings.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const TENANT = 'tenant-assistant';
const OTHER_TENANT = 'tenant-neighbour';
const PROVIDER = 'test-provider';
const MODEL = 'test-model';

const readTool: AgentTool = {
	id: 'catalog.item.read',
	transport: 'api',
	target: 'catalog.items.get',
	description: 'Read a catalog item.',
	requiredPermissions: ['catalog.items.read'],
	execute: async () => ({ id: 'item-1' }),
};

const writeTool: AgentTool = {
	id: 'catalog.item.update',
	transport: 'api',
	target: 'catalog.items.update',
	description: 'Update a catalog item.',
	requiredPermissions: ['catalog.items.manage'],
	execute: async () => ({ id: 'item-1', updated: true }),
};

/* Answers the prompt it was given, and reaches for the write tool when the
   member asked for an update, so a run proves what the harness allows it. */
const provider: AgentProvider = {
	id: PROVIDER,
	execute: async (context) => {
		let refusal: string | null = null;
		if (context.request.input.toLowerCase().includes('update')) {
			try {
				await context.invokeTool(writeTool.id, {});
			} catch (error) {
				refusal = error instanceof Error ? error.message : 'refused';
			}
		}
		return {
			output: refusal ?? `answered: ${context.request.input.slice(-40)}`,
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			finishReason: 'stop',
		};
	},
};

let database: AgentsTestDatabase;
const workers: AgentWorker[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
});

beforeEach(async () => {
	await database.truncate();
});

afterEach(async () => {
	for (const worker of workers.splice(0)) await worker.dispose();
});

afterAll(async () => {
	await database.dispose();
});

function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 5_000,
): Promise<void> {
	const startedAt = Date.now();
	return new Promise<void>((resolve, reject) => {
		const tick = async () => {
			if (await predicate()) return resolve();
			if (Date.now() - startedAt > timeoutMs) {
				return reject(new Error('Condition was not met in time.'));
			}
			setTimeout(() => void tick(), 10);
		};
		void tick();
	});
}

/* A settings runtime the case controls, so the flag is read live exactly as
   Administration would change it. */
function settingsReader(values: Record<string, unknown>): AgentSettingsReader {
	return agentSettings({
		environment: {},
		settings: {
			prime: async () => {},
			get: (_tenantId: string, _moduleId: string, key: string) => values[key],
		},
	});
}

function fixture(settings?: AgentSettingsReader, usableProvider = true) {
	const repository = database.repository;
	const harness = new AgentHarness({
		providers: [provider],
		tools: [readTool, writeTool],
	});
	const worker = new AgentWorker(repository, harness, {
		workerId: `worker:assistant-${workers.length}`,
		concurrency: 1,
		leaseMs: 2_000,
	});
	workers.push(worker);
	const agents = new AgentService(
		repository,
		harness,
		worker,
		undefined,
		Date.now,
		settings,
	);
	const assistant = new AssistantService(
		repository,
		agents,
		{ hasUsableModel: async () => usableProvider },
		settings,
	);
	return { repository, harness, worker, agents, assistant };
}

function member(overrides: Partial<AssistantMember> = {}): AssistantMember {
	return {
		tenantId: TENANT,
		accountId: 'member-a',
		displayName: 'Ada Lovelace',
		email: 'ada@example.test',
		tenantName: 'Acme',
		scopes: [AGENT_PERMISSIONS.assistantUse, 'catalog.items.read'],
		...overrides,
	};
}

async function register(agents: AgentService): Promise<void> {
	await agents.reconcileModuleAgents([
		assistantAgentDefinition([readTool.id, writeTool.id]),
	]);
}

async function bind(
	agents: AgentService,
	tenantId = TENANT,
	enabledTools: readonly string[] = [readTool.id, writeTool.id],
): Promise<void> {
	await agents.configureModuleAgent(tenantId, 'owner-a', {
		agentId: ASSISTANT_AGENT_ID,
		provider: PROVIDER,
		model: MODEL,
		enabledTools,
		status: 'active',
		expectedRevision: 0,
	});
}

async function answered(
	fix: ReturnType<typeof fixture>,
	who: AssistantMember,
	threadId: string,
	sequence: number,
) {
	await fix.worker.start();
	await waitFor(async () => {
		const conversation = await fix.assistant.readThread(who, threadId);
		return (
			conversation.turns.find((turn) => turn.sequence === sequence)?.status !==
			'pending'
		);
	});
	return await fix.assistant.readThread(who, threadId);
}

describe('workspace assistant', () => {
	it('ASSISTANT-LOCKED: reads locked and names the configuration that is missing', async () => {
		const withoutProvider = fixture(undefined, false);
		await register(withoutProvider.agents);
		expect(await withoutProvider.assistant.readiness(member())).toMatchObject({
			enabled: true,
			permitted: true,
			providerReady: false,
			bindingConfigured: false,
			ready: false,
			lockedReason: 'provider-missing',
			configureHref: '/agent-providers',
			agentId: ASSISTANT_AGENT_ID,
		});

		const unbound = fixture();
		await register(unbound.agents);
		expect(await unbound.assistant.readiness(member())).toMatchObject({
			providerReady: true,
			bindingConfigured: false,
			ready: false,
			lockedReason: 'binding-missing',
			configureHref: '/agents',
		});
		await expect(
			unbound.assistant.startThread(member(), { message: 'Hello.' }),
		).rejects.toMatchObject({ code: 'ASSISTANT_NOT_CONFIGURED', status: 409 });
		expect(
			await unbound.repository.listRuns(TENANT, {
				direction: 'desc',
				status: null,
				agentId: null,
				trigger: null,
				search: null,
				limit: 10,
				after: null,
			}),
		).toEqual([]);

		await bind(unbound.agents);
		expect(await unbound.assistant.readiness(member())).toMatchObject({
			ready: true,
			lockedReason: null,
			configureHref: null,
		});
		/* A member without the permission is told so, so the header renders no
		   entry point rather than a lock. */
		expect(
			await unbound.assistant.readiness(member({ scopes: [] })),
		).toMatchObject({
			permitted: false,
			ready: false,
			lockedReason: 'forbidden',
		});
	});

	it('ASSISTANT-TURN: queues a run as the member and carries the earlier turns', async () => {
		const fix = fixture();
		await register(fix.agents);
		await bind(fix.agents);
		const asking = member();
		const started = await fix.assistant.startThread(asking, {
			message: 'How many open orders are there?',
		});
		expect(started.thread).toMatchObject({
			tenantId: TENANT,
			accountId: 'member-a',
			title: 'How many open orders are there?',
			turnCount: 1,
		});
		expect(started.turns).toHaveLength(1);
		const firstRunId = started.turns[0]!.runId!;

		const queued = (await fix.repository.getRun(TENANT, firstRunId))!;
		expect(queued).toMatchObject({
			agentId: ASSISTANT_AGENT_ID,
			requestedBy: 'member-a',
			requestedActor: { kind: 'user', id: 'member-a', label: 'Ada Lovelace' },
			permissionSnapshot: ['agents.assistant.use', 'catalog.items.read'],
			toolGrants: [readTool.id, writeTool.id],
		});

		const settled = await answered(fix, asking, started.thread.id, 1);
		expect(settled.turns[0]).toMatchObject({
			status: 'answered',
			question: 'How many open orders are there?',
		});
		expect(settled.turns[0]!.answer).toContain('answered:');

		const continued = await fix.assistant.continueThread(asking, {
			threadId: started.thread.id,
			message: 'And how many of those are late?',
		});
		expect(continued.thread.turnCount).toBe(2);
		expect(continued.turns.map((turn) => turn.sequence)).toEqual([1, 2]);
		const second = (await fix.repository.getRun(
			TENANT,
			continued.turns[1]!.runId!,
		))!;
		expect(second.input).toContain('Earlier in this conversation:');
		expect(second.input).toContain('How many open orders are there?');
		expect(second.input).toContain('Assistant: answered:');
		expect(second.input.endsWith('And how many of those are late?')).toBe(true);

		/* The run history carries the turn like any other run. */
		const history = await fix.repository.listRuns(TENANT, {
			direction: 'desc',
			status: null,
			agentId: ASSISTANT_AGENT_ID,
			trigger: null,
			search: null,
			limit: 10,
			after: null,
		});
		expect(history).toHaveLength(2);
	});

	it('ASSISTANT-TOOL-DENIED: refuses a tool the member cannot use and records both identities', async () => {
		const fix = fixture();
		await register(fix.agents);
		await bind(fix.agents);
		const asking = member();
		const started = await fix.assistant.startThread(asking, {
			message: 'Please update the item price.',
		});
		const settled = await answered(fix, asking, started.thread.id, 1);
		expect(settled.turns[0]!.answer).toContain('was not granted');

		const run = await fix.agents.getRun(TENANT, started.turns[0]!.runId!);
		expect(run.status).toBe('succeeded');
		expect(
			run.events.filter((event) => event.type === 'tool.denied'),
		).toMatchObject([
			{ metadata: { tool: writeTool.id, reason: 'TOOL_NOT_GRANTED' } },
		]);
		/* The member is the actor of the refused call and the assistant is the
		   agent that made it on their behalf. */
		expect(run.requestedActor).toMatchObject({ kind: 'user', id: 'member-a' });
		expect(run.agentId).toBe(ASSISTANT_AGENT_ID);
		expect(await fix.repository.verifyAuditChain(TENANT)).toBe(true);
	});

	it('ASSISTANT-PRIVATE: keeps a conversation to the member who started it', async () => {
		const fix = fixture();
		await register(fix.agents);
		await bind(fix.agents);
		const owner = member({
			accountId: 'owner-b',
			displayName: 'Owner',
			email: 'owner@example.test',
			scopes: [
				AGENT_PERMISSIONS.assistantUse,
				AGENT_PERMISSIONS.definitionsManage,
				AGENT_PERMISSIONS.runsRead,
			],
		});
		const started = await fix.assistant.startThread(member(), {
			message: 'A private question.',
		});

		expect(
			(await fix.assistant.listThreads(owner, { limit: 10, after: null }))
				.threads,
		).toEqual([]);
		for (const attempt of [
			fix.assistant.readThread(owner, started.thread.id),
			fix.assistant.continueThread(owner, {
				threadId: started.thread.id,
				message: 'Let me in.',
			}),
			fix.assistant.renameThread(owner, started.thread.id, 'Mine now'),
			fix.assistant.deleteThread(owner, started.thread.id),
		]) {
			await expect(attempt).rejects.toMatchObject({
				code: 'ASSISTANT_THREAD_NOT_FOUND',
				status: 404,
			});
		}
		/* The run history still shows that the run happened. */
		expect(
			await fix.repository.listRuns(TENANT, {
				direction: 'desc',
				status: null,
				agentId: null,
				trigger: null,
				search: null,
				limit: 10,
				after: null,
			}),
		).toHaveLength(1);

		const own = await fix.assistant.readThread(member(), started.thread.id);
		expect(own.thread.id).toBe(started.thread.id);
		await fix.assistant.renameThread(member(), started.thread.id, 'My thread');
		await fix.assistant.deleteThread(member(), started.thread.id);
		await expect(
			fix.assistant.readThread(member(), started.thread.id),
		).rejects.toMatchObject({ code: 'ASSISTANT_THREAD_NOT_FOUND' });
	});

	it('ASSISTANT-DISABLED: refuses with a stable code while the flag is off', async () => {
		const values: Record<string, unknown> = { assistantEnabled: true };
		const fix = fixture(settingsReader(values));
		await register(fix.agents);
		await bind(fix.agents);
		const asking = member();
		const started = await fix.assistant.startThread(asking, {
			message: 'Kept for later.',
		});

		values.assistantEnabled = false;
		expect(await fix.assistant.readiness(asking)).toMatchObject({
			enabled: false,
			ready: false,
			lockedReason: 'disabled',
		});
		for (const attempt of [
			fix.assistant.listThreads(asking, { limit: 10, after: null }),
			fix.assistant.readThread(asking, started.thread.id),
			fix.assistant.startThread(asking, { message: 'Again.' }),
			fix.assistant.continueThread(asking, {
				threadId: started.thread.id,
				message: 'Again.',
			}),
			fix.assistant.renameThread(asking, started.thread.id, 'Renamed'),
			fix.assistant.deleteThread(asking, started.thread.id),
		]) {
			await expect(attempt).rejects.toMatchObject({
				code: 'ASSISTANT_DISABLED',
				status: 409,
			});
		}

		values.assistantEnabled = true;
		expect(
			(await fix.assistant.readThread(asking, started.thread.id)).thread.title,
		).toBe('Kept for later.');
	});

	it('keeps one workspace out of another workspace conversations', async () => {
		const fix = fixture();
		await register(fix.agents);
		await bind(fix.agents);
		await bind(fix.agents, OTHER_TENANT);
		const started = await fix.assistant.startThread(member(), {
			message: 'Workspace one.',
		});
		/* The same account in another workspace, which is what a member with two
		   memberships actually looks like. */
		const elsewhere = member({ tenantId: OTHER_TENANT });

		expect(
			(await fix.assistant.listThreads(elsewhere, { limit: 10, after: null }))
				.threads,
		).toEqual([]);
		await expect(
			fix.assistant.readThread(elsewhere, started.thread.id),
		).rejects.toMatchObject({ code: 'ASSISTANT_THREAD_NOT_FOUND' });
	});

	it('keeps a thread readable after run retention sweeps the runs behind it', async () => {
		const fix = fixture();
		await register(fix.agents);
		await bind(fix.agents);
		const asking = member();
		const started = await fix.assistant.startThread(asking, {
			message: 'Answer me once.',
		});
		/* The worker writes the answer onto the turn when it settles the run, so
		   a member who never reopened the thread still has it. */
		const stored = async () =>
			(await fix.repository.readAssistantThread(
				TENANT,
				'member-a',
				started.thread.id,
			))!.turns[0]!;
		await fix.worker.start();
		await waitFor(async () => (await stored()).status === 'answered');
		const answer = (await stored()).answer!;
		expect(answer).toContain('answered:');

		expect(
			await fix.repository.deleteSettledRunsBefore(TENANT, Date.now() + 1, 10),
		).toBe(1);
		expect(
			await fix.repository.getRun(TENANT, started.turns[0]!.runId!),
		).toBeNull();

		const surviving = await fix.assistant.readThread(asking, started.thread.id);
		expect(surviving.turns[0]).toMatchObject({
			status: 'answered',
			question: 'Answer me once.',
			answer,
			runId: started.turns[0]!.runId,
		});
	});

	it('records every assistant action with the member and the assistant agent', async () => {
		const fix = fixture();
		await register(fix.agents);
		await bind(fix.agents);
		const asking = member();
		const started = await fix.assistant.startThread(asking, {
			message: 'Audit me.',
		});
		await fix.assistant.continueThread(asking, {
			threadId: started.thread.id,
			message: 'And again.',
		});
		await fix.assistant.renameThread(asking, started.thread.id, 'Audited');
		await fix.assistant.deleteThread(asking, started.thread.id);

		const events = await fix.repository.listAuditEvents(TENANT, 50);
		const assistantEvents = events.filter((event) =>
			event.action.startsWith('assistant.'),
		);
		expect(assistantEvents.map((event) => event.action).sort()).toEqual([
			'assistant.thread-deleted',
			'assistant.thread-renamed',
			'assistant.thread-started',
			'assistant.turn-added',
		]);
		for (const event of assistantEvents) {
			expect(event.actorId).toBe('member-a');
			expect(event.subjectType).toBe('assistant-thread');
			expect(event.subjectId).toBe(started.thread.id);
			expect(event.metadata.onBehalfOfAgent).toBe(ASSISTANT_AGENT_ID);
		}
		/* The queued run names the member too, so the trail reads as one story. */
		expect(
			events
				.filter((event) => event.action === 'agent-run.queued')
				.map((event) => event.actorId),
		).toEqual(['member-a', 'member-a']);
		expect(await fix.repository.verifyAuditChain(TENANT)).toBe(true);
	});

	it('erases the threads of the account whose runs an erasure removes', async () => {
		const fix = fixture();
		await register(fix.agents);
		await bind(fix.agents);
		await fix.assistant.startThread(member(), { message: 'Mine.' });
		await fix.assistant.startThread(member({ accountId: 'member-b' }), {
			message: 'Theirs.',
		});

		expect(
			await fix.repository.deleteAssistantThreadsOf(TENANT, 'member-a', 10),
		).toBe(1);
		expect(
			(await fix.assistant.listThreads(member(), { limit: 10, after: null }))
				.threads,
		).toEqual([]);
		expect(
			(
				await fix.assistant.listThreads(member({ accountId: 'member-b' }), {
					limit: 10,
					after: null,
				})
			).threads,
		).toHaveLength(1);
	});

	it('pages a member own conversations newest first', async () => {
		const fix = fixture();
		await register(fix.agents);
		await bind(fix.agents);
		for (const message of ['One.', 'Two.', 'Three.']) {
			await fix.assistant.startThread(member(), { message });
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		const first = await fix.assistant.listThreads(member(), {
			limit: 2,
			after: null,
		});
		expect(first.threads.map((thread) => thread.title)).toEqual([
			'Three.',
			'Two.',
		]);
		const next = await fix.assistant.listThreads(member(), {
			limit: 2,
			after: first.last,
		});
		expect(next.threads.map((thread) => thread.title)).toEqual(['One.']);
	});

	it('keeps the registry allowlist out of the definition content the revision pins', async () => {
		const fix = fixture();
		await fix.agents.reconcileModuleAgents([
			assistantAgentDefinition([readTool.id]),
		]);
		/* A deployment that composes another module registers more tools. That is
		   not this module's source changing, so the same revision is accepted. */
		await fix.agents.reconcileModuleAgents([
			assistantAgentDefinition([readTool.id, writeTool.id]),
		]);
		expect(
			(await fix.agents.getModuleAgent(TENANT, ASSISTANT_AGENT_ID))
				?.allowedTools,
		).toEqual([readTool.id, writeTool.id]);

		const drifted = {
			...assistantAgentDefinition([readTool.id]),
			instructions: 'Changed without a definition revision bump.',
		};
		await expect(fix.agents.reconcileModuleAgents([drifted])).rejects.toThrow(
			/MODULE_AGENT_REVISION_DRIFT/,
		);
	});
});
