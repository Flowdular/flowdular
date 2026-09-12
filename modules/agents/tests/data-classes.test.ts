import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentHarness } from '@flowdular/harness';
import { createDataClassRegistry } from '@flowdular/kernel';
import type { CreateAgentInput } from '../src/domain/types.ts';
import { AgentService } from '../src/services/agent-service.ts';
import { AgentWorker } from '../src/services/worker.ts';
import { AesGcmCredentialVault } from '../src/services/credential-vault.ts';
import { AgentProviderService } from '../src/services/provider-service.ts';
import {
	agentsDataClasses,
	RUN_RETENTION_DAYS,
} from '../src/services/data-classes.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const TENANT = 'tenant-classes';
const OTHER = 'tenant-other';
const ADA = 'account-ada';
const BO = 'account-bo';
const DAY_MS = 86_400_000;
const SEPTEMBER = Date.UTC(2026, 8, 11, 9, 30, 0);
const CREDENTIAL = 'sk-provider-test-credential';

const input: CreateAgentInput = {
	key: 'retention-agent',
	name: 'Retention agent',
	description: 'Produces runs the retention pass can age out.',
	instructions: 'Answer briefly.',
	provider: 'test-provider',
	model: 'test-model',
	allowedTools: [],
	procedureIds: [],
	maxSteps: 2,
	timeoutMs: 1_000,
	temperature: 0,
	status: 'draft',
};

let database: AgentsTestDatabase;
let clock = SEPTEMBER;
const workers: AgentWorker[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
});

beforeEach(async () => {
	await database.truncate();
	clock = SEPTEMBER;
	for (const worker of workers.splice(0)) await worker.dispose();
});

afterAll(async () => {
	for (const worker of workers.splice(0)) await worker.dispose();
	await database.dispose();
});

/* A stopped worker, so every run in this file settles exactly where the case
   puts it instead of being drained by a background poll. */
function service(): AgentService {
	const harness = new AgentHarness({
		providers: [
			{
				id: 'test-provider',
				execute: async () => {
					throw new Error('No run in this file reaches a provider.');
				},
			},
		],
	});
	const worker = new AgentWorker(database.repository, harness, {
		workerId: 'worker:classes',
		concurrency: 1,
		leaseMs: 1_000,
		now: () => clock,
	});
	worker.stop();
	workers.push(worker);
	return new AgentService(
		database.repository,
		harness,
		worker,
		undefined,
		() => clock,
	);
}

async function activeAgent(
	agents: AgentService,
	tenantId: string,
): Promise<string> {
	const created = await agents.createAgent(tenantId, ADA, input);
	const active = await agents.updateAgent(tenantId, created.id, ADA, {
		...input,
		status: 'active',
		expectedRevision: created.revision,
	});
	return active.id;
}

/** One run, queued and settled at `at`, unless `settle` says to leave it queued. */
async function seedRun(
	agents: AgentService,
	tenantId: string,
	agentId: string,
	requestedBy: string,
	at: number,
	settle: 'succeeded' | 'queued' = 'succeeded',
): Promise<string> {
	clock = at;
	const queued = await agents.enqueueRun(tenantId, requestedBy, [], {
		agentId,
		trigger: 'service',
		input: `Run at ${at}`,
		toolGrants: [],
	});
	if (settle === 'queued') return queued.id;
	const claimed = await database.repository.claimRun(
		tenantId,
		queued.id,
		'worker:seed',
		at,
		at + 1_000,
		{
			tenantId,
			actorId: 'worker:seed',
			action: 'agent-run.claimed',
			subjectType: 'agent-run',
			subjectId: queued.id,
			metadata: {},
			occurredAt: at,
		},
	);
	if (!claimed) throw new Error('The seeded run could not be claimed.');
	await database.repository.appendRunEvent(tenantId, queued.id, {
		sequence: 1,
		type: 'run.completed',
		timestamp: at,
		message: 'The agent answered.',
		metadata: {},
	});
	await database.repository.completeRun(
		tenantId,
		queued.id,
		'worker:seed',
		{
			output: 'done',
			structuredOutput: null,
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			finishReason: 'stop',
			startedAt: at,
			completedAt: at,
			events: [],
		},
		{
			tenantId,
			actorId: 'worker:seed',
			action: 'agent-run.succeeded',
			subjectType: 'agent-run',
			subjectId: queued.id,
			metadata: {},
			occurredAt: at,
		},
	);
	return queued.id;
}

function declared(
	key: 'runs' | 'audit-events' | 'provider-credentials',
	pageSize?: number,
) {
	const registry = createDataClassRegistry();
	registry.declare(
		'agents.core',
		pageSize === undefined
			? agentsDataClasses(async () => database.repository)
			: agentsDataClasses(async () => database.repository, pageSize),
	);
	const declaration = registry
		.list()
		.find((module) => module.moduleId === 'agents.core')
		?.classes.find((item) => item.key === key);
	if (!declaration) throw new Error(`agents.core declared no ${key} class.`);
	return declaration;
}

async function exported(
	key: 'runs' | 'audit-events',
	tenantId: string,
	pageSize?: number,
): Promise<readonly Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	await declared(key, pageSize).export!({
		tenantId,
		sink: {
			write: async (row) => {
				rows.push(row);
			},
		},
	});
	return rows;
}

async function runIds(tenantId: string): Promise<readonly string[]> {
	return (await exported('runs', tenantId)).map((row) => String(row['id']));
}

describe('agents.core data classes', () => {
	it('declares runs, the audit trail and provider credentials with their retention', () => {
		const registry = createDataClassRegistry();
		registry.declare(
			'agents.core',
			agentsDataClasses(async () => database.repository),
		);

		expect(
			registry
				.list()
				.flatMap((module) =>
					module.classes.map((declaration) => [
						`${module.moduleId}.${declaration.key}`,
						declaration.defaultRetentionDays,
						declaration.exportable,
						Boolean(declaration.sweep),
						Boolean(declaration.erase),
					]),
				),
		).toEqual([
			['agents.core.runs', RUN_RETENTION_DAYS, true, true, true],
			['agents.core.audit-events', null, true, false, false],
			['agents.core.provider-credentials', null, false, false, false],
		]);
		expect(declared('provider-credentials').excludedReason).toContain(
			'encrypted provider credential',
		);
	});

	it('sweeps settled runs older than the cutoff in one workspace only', async () => {
		const agents = service();
		const agentId = await activeAgent(agents, TENANT);
		const otherAgentId = await activeAgent(agents, OTHER);
		const oldest = await seedRun(
			agents,
			TENANT,
			agentId,
			ADA,
			SEPTEMBER - 3 * DAY_MS,
		);
		const cutoffDay = await seedRun(
			agents,
			TENANT,
			agentId,
			ADA,
			SEPTEMBER - DAY_MS,
		);
		const newest = await seedRun(agents, TENANT, agentId, ADA, SEPTEMBER);
		const queued = await seedRun(
			agents,
			TENANT,
			agentId,
			ADA,
			SEPTEMBER - 9 * DAY_MS,
			'queued',
		);
		const foreign = await seedRun(
			agents,
			OTHER,
			otherAgentId,
			BO,
			SEPTEMBER - 3 * DAY_MS,
		);

		const removed = await declared('runs').sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER - DAY_MS),
			limit: 100,
		});

		/* The oldest settled run goes. The run settled exactly on the cutoff
		   stays, which is what "strictly older" means, and the run still queued
		   stays however old the request behind it is. */
		expect(removed).toEqual({ removed: 1 });
		expect([...(await runIds(TENANT))].sort()).toEqual(
			[newest, cutoffDay, queued].sort(),
		);
		expect(await runIds(TENANT)).not.toContain(oldest);
		expect(await runIds(OTHER)).toEqual([foreign]);
	});

	it('removes no more runs than the limit it was given', async () => {
		const agents = service();
		const agentId = await activeAgent(agents, TENANT);
		for (let offset = 0; offset < 3; offset += 1) {
			await seedRun(agents, TENANT, agentId, ADA, SEPTEMBER - offset * DAY_MS);
		}

		const removed = await declared('runs').sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER + DAY_MS),
			limit: 2,
		});

		expect(removed).toEqual({ removed: 2 });
		expect(await runIds(TENANT)).toHaveLength(1);
	});

	it('takes the steps of a swept run with it', async () => {
		const agents = service();
		const agentId = await activeAgent(agents, TENANT);
		const runId = await seedRun(agents, TENANT, agentId, ADA, SEPTEMBER);
		expect(
			await database.repository.listRunEvents(TENANT, runId, 0),
		).toHaveLength(1);

		await declared('runs').sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER + DAY_MS),
			limit: 10,
		});

		expect(await database.repository.listRunEvents(TENANT, runId, 0)).toEqual(
			[],
		);
	});

	it('exports one workspace with its runs, steps and time range', async () => {
		const agents = service();
		const agentId = await activeAgent(agents, TENANT);
		const otherAgentId = await activeAgent(agents, OTHER);
		await seedRun(agents, TENANT, agentId, ADA, SEPTEMBER - 2 * DAY_MS);
		await seedRun(agents, TENANT, agentId, ADA, SEPTEMBER);
		await seedRun(agents, OTHER, otherAgentId, BO, SEPTEMBER);
		const rows: Record<string, unknown>[] = [];

		const summary = await declared('runs').export!({
			tenantId: TENANT,
			sink: {
				write: async (row) => {
					rows.push(row);
				},
			},
		});

		expect(summary.rows).toBe(2);
		expect(summary.from?.toISOString()).toBe(
			new Date(SEPTEMBER - 2 * DAY_MS).toISOString(),
		);
		expect(summary.to?.toISOString()).toBe(new Date(SEPTEMBER).toISOString());
		expect(rows.every((row) => row['tenantId'] === TENANT)).toBe(true);
		expect(rows[0]).toMatchObject({
			requestedBy: ADA,
			status: 'succeeded',
			queuedAt: new Date(SEPTEMBER).toISOString(),
		});
		expect(rows[0]!['steps']).toEqual([
			{
				sequence: 1,
				type: 'run.completed',
				message: 'The agent answered.',
				metadata: {},
				occurredAt: new Date(SEPTEMBER).toISOString(),
			},
		]);
	});

	it('walks the run export in keyset pages rather than one query', async () => {
		const agents = service();
		const agentId = await activeAgent(agents, TENANT);
		for (let offset = 0; offset < 5; offset += 1) {
			await seedRun(agents, TENANT, agentId, ADA, SEPTEMBER - offset * DAY_MS);
		}

		const rows = await exported('runs', TENANT, 2);

		expect(rows).toHaveLength(5);
		expect(new Set(rows.map((row) => row['id'])).size).toBe(5);
	});

	it('pages a run export whose rows share one queue time', async () => {
		const agents = service();
		const agentId = await activeAgent(agents, TENANT);
		for (let index = 0; index < 4; index += 1) {
			await seedRun(agents, TENANT, agentId, ADA, SEPTEMBER);
		}

		const rows = await exported('runs', TENANT, 2);

		expect(new Set(rows.map((row) => row['id'])).size).toBe(4);
	});

	it('exports nothing and reports no range for a workspace that holds none', async () => {
		const agents = service();
		const agentId = await activeAgent(agents, TENANT);
		await seedRun(agents, TENANT, agentId, ADA, SEPTEMBER);

		for (const key of ['runs', 'audit-events'] as const) {
			expect(
				await declared(key).export!({
					tenantId: 'tenant-empty',
					sink: { write: async () => undefined },
				}),
			).toEqual({ rows: 0, from: null, to: null });
		}
	});

	it('exports the audit trail in chain order and sweeps none of it', async () => {
		const agents = service();
		const agentId = await activeAgent(agents, TENANT);
		await seedRun(agents, TENANT, agentId, ADA, SEPTEMBER);

		const rows = await exported('audit-events', TENANT, 2);

		expect(rows.map((row) => row['sequence'])).toEqual([1, 2, 3, 4, 5]);
		expect(rows.every((row) => row['tenantId'] === TENANT)).toBe(true);
		/* Chained rows: a sweep would break the link the next verification
		   walks, so the class declares none. */
		expect(declared('audit-events').sweep).toBeUndefined();
		expect(await database.repository.verifyAuditChain(TENANT)).toBe(true);
	});

	it('keeps the provider credential out of every exportable class', async () => {
		const agents = service();
		const providers = new AgentProviderService(
			database.providers,
			new AesGcmCredentialVault(Buffer.alloc(32, 3)),
			database.repository,
			{
				hostAllowlist: new Set<string>(),
				readinessTtlMs: 60_000,
				readinessTimeoutMs: 1_000,
				now: () => clock,
			},
		);
		await providers.create(TENANT, ADA, {
			key: 'primary-openai',
			name: 'Primary OpenAI',
			kind: 'openai',
			credential: CREDENTIAL,
			models: [
				{
					id: 'gpt-4o-mini',
					label: 'GPT-4o mini',
					enabled: true,
					supportsTools: true,
					supportsStreaming: true,
					supportsWebSearch: false,
				},
			],
		});
		const agentId = await activeAgent(agents, TENANT);
		await seedRun(agents, TENANT, agentId, ADA, SEPTEMBER);

		const archive = JSON.stringify([
			await exported('runs', TENANT),
			await exported('audit-events', TENANT),
		]);

		expect(archive).not.toContain(CREDENTIAL);
		expect(archive).not.toContain('credential_ciphertext');
		expect(declared('provider-credentials').export).toBeUndefined();
	});

	it('erases the runs one account requested and leaves the others', async () => {
		const agents = service();
		const agentId = await activeAgent(agents, TENANT);
		const otherAgentId = await activeAgent(agents, OTHER);
		const ada = await seedRun(agents, TENANT, agentId, ADA, SEPTEMBER);
		const bo = await seedRun(agents, TENANT, agentId, BO, SEPTEMBER);
		const foreign = await seedRun(agents, OTHER, otherAgentId, ADA, SEPTEMBER);

		const result = await declared('runs').erase!({
			tenantId: TENANT,
			subject: { accountId: ADA },
			limit: 100,
		});

		expect(result).toEqual({ removed: 1 });
		expect(await runIds(TENANT)).toEqual([bo]);
		expect(await runIds(TENANT)).not.toContain(ada);
		/* Another workspace's runs of the same person are that workspace's
		   erasure, not this one's. */
		expect(await runIds(OTHER)).toEqual([foreign]);
	});

	it('reports an erasure batch that filled its limit as truncated', async () => {
		const agents = service();
		const agentId = await activeAgent(agents, TENANT);
		for (let index = 0; index < 3; index += 1) {
			await seedRun(agents, TENANT, agentId, ADA, SEPTEMBER - index * DAY_MS);
		}

		const first = await declared('runs').erase!({
			tenantId: TENANT,
			subject: { accountId: ADA },
			limit: 2,
		});
		const second = await declared('runs').erase!({
			tenantId: TENANT,
			subject: { accountId: ADA },
			limit: 2,
		});

		expect(first).toEqual({ removed: 2, truncated: true });
		expect(second).toEqual({ removed: 1 });
		expect(await runIds(TENANT)).toEqual([]);
	});

	it('erases a run that is still queued', async () => {
		const agents = service();
		const agentId = await activeAgent(agents, TENANT);
		await seedRun(agents, TENANT, agentId, ADA, SEPTEMBER, 'queued');

		expect(
			await declared('runs').erase!({
				tenantId: TENANT,
				subject: { accountId: ADA },
				limit: 10,
			}),
		).toEqual({ removed: 1 });
		expect(await runIds(TENANT)).toEqual([]);
	});
});
