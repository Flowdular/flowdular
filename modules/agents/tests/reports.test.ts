import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentHarness, type AgentProvider } from '@flowdular/harness';
import type { PlatformServerContext } from '@flowdular/module-auth/server';
import {
	createDataClassRegistry,
	createPlatformAgentRegistry,
	createPlatformCapabilityRegistry,
} from '@flowdular/kernel';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapterLease,
	type DatabaseHandle,
	type DatabaseTransactionOptions,
} from '@flowdular/database';
import {
	REPORTS_PROVIDERS_CAPABILITY,
	type ReportProvider,
	type ReportProviderRegistry,
} from '@flowdular/module-reports';
import { AGENT_PERMISSIONS } from '../src/acl/permissions.ts';
import type { CreateAgentInput } from '../src/domain/types.ts';
import { createServerComposition } from '../src/platform.ts';
import { AgentService } from '../src/services/agent-service.ts';
import { AgentWorker } from '../src/services/worker.ts';
import { DatabaseAgentRepository } from '../src/services/database-repository.ts';
import {
	AGENT_RUNS_REPORT_LABEL_KEYS,
	AGENT_RUNS_REPORT_PROVIDER_KEY,
	AGENT_RUNS_REPORT_PROVIDER_LABEL,
	createAgentRunsReportProvider,
	runsAnswer,
} from '../src/services/reports.ts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const TENANT = 'tenant-reports';
const OTHER = 'tenant-other';
const ADA = 'account-ada';
const INSIDE = { from: '2026-09-01', to: '2026-09-30' } as const;

const input: CreateAgentInput = {
	key: 'reported-agent',
	name: 'Reported agent',
	description: 'Settles runs the report reads.',
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

const provider: AgentProvider = {
	id: 'test-provider',
	execute: async () => ({
		output: 'done',
		usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
		finishReason: 'stop',
	}),
};

/** The registry reports.core would register, keeping what this module offered. */
class FakeReportRegistry implements ReportProviderRegistry {
	readonly registrations: {
		moduleId: string;
		providers: readonly ReportProvider[];
	}[] = [];

	register(moduleId: string, providers: readonly ReportProvider[]): void {
		this.registrations.push({ moduleId, providers });
	}
}

let database: AgentsTestDatabase;
let lease: DatabaseAdapterLease;
const workers: AgentWorker[] = [];
const compositions: { dispose?: () => unknown }[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
	lease = await database.databases.acquire({
		namespace: 'agents.core',
		purpose: 'test',
		requirements: {
			dialectIds: [DATABASE_DIALECT_IDS.postgresql],
			capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
		},
	});
});

beforeEach(async () => {
	for (const worker of workers.splice(0)) await worker.dispose();
	await database.truncate();
});

afterAll(async () => {
	for (const worker of workers.splice(0)) await worker.dispose();
	for (const composed of compositions.splice(0)) await composed.dispose?.();
	await lease?.release();
	await database?.dispose();
});

function compose(reports: FakeReportRegistry) {
	const capabilities = createPlatformCapabilityRegistry();
	capabilities.register(REPORTS_PROVIDERS_CAPABILITY, reports);
	const composed = createServerComposition({
		environment: {
			FD_AGENT_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
			FD_AGENT_RUN_GRANT_KEY: Buffer.alloc(32, 8).toString('base64'),
		},
		workspaceRoot: process.cwd(),
		databases: database.databases,
		auth: {},
		agentTools: { register: () => undefined, list: () => [] },
		agentDefinitions: createPlatformAgentRegistry(),
		dataClasses: createDataClassRegistry().forModule('agents.core'),
		capabilities,
	} as unknown as PlatformServerContext);
	compositions.push(composed);
	return composed;
}

async function runtime() {
	const harness = new AgentHarness({ providers: [provider] });
	const worker = new AgentWorker(database.repository, harness, {
		workerId: 'worker:reports',
		concurrency: 1,
		leaseMs: 1_000,
	});
	workers.push(worker);
	await worker.start();
	return new AgentService(database.repository, harness, worker);
}

async function activeAgent(service: AgentService, tenantId = TENANT) {
	const created = await service.createAgent(tenantId, ADA, input);
	return service.updateAgent(tenantId, created.id, ADA, {
		...input,
		status: 'active',
		expectedRevision: created.revision,
	});
}

async function waitForTerminal(
	service: AgentService,
	runId: string,
	tenantId = TENANT,
) {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const run = await service.getRun(tenantId, runId);
		if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('The reported run did not finish in time.');
}

/* Runs settle on the day the worker finished them, so a case that needs several
   days moves the settled rollup rows rather than faking a clock inside the
   worker. The rollup row is what the provider reads, and it is unchanged
   otherwise. */
async function moveRun(runId: string, day: string, tenantId = TENANT) {
	await lease.database.transaction(
		(transaction) =>
			transaction.execute({
				text: `UPDATE agent_run_costs SET day = $1
				 WHERE tenant_id = $2 AND run_id = $3`,
				parameters: [day, tenantId, runId],
			}),
		{ access: 'write', tenantId },
	);
}

async function settle(
	service: AgentService,
	agentId: string,
	tenantId = TENANT,
) {
	const queued = await service.enqueueRun(tenantId, ADA, [], {
		agentId,
		trigger: 'service',
		input: 'Report me.',
		toolGrants: [],
	});
	await waitForTerminal(service, queued.id, tenantId);
	return queued.id;
}

function read(tenantId = TENANT) {
	return createAgentRunsReportProvider(async () => database.repository).read({
		tenantId,
		principal: {
			accountId: ADA,
			tenantId,
			scopes: [AGENT_PERMISSIONS.runsRead],
		},
		range: INSIDE,
	});
}

/**
 * The real handle, recording what the repository asked the database for and
 * firing the caller's budget once the transaction is open, so a case sees what
 * the statement in flight does with the signal it was handed.
 */
function abortingHandle(handle: DatabaseHandle, expireBudget: () => void) {
	const asked: (DatabaseTransactionOptions | undefined)[] = [];
	const recording = new Proxy(handle, {
		get(target, property) {
			if (property === 'transaction') {
				return (
					operation: (transaction: never) => Promise<unknown>,
					options?: DatabaseTransactionOptions,
				) => {
					asked.push(options);
					return target.transaction(async (transaction) => {
						expireBudget();
						return operation(transaction as never);
					}, options);
				};
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	return { asked, handle: recording };
}

describe('AGENTS-REPORT-RUNS', () => {
	it('registers its report provider while the platform composes', () => {
		const reports = new FakeReportRegistry();

		compose(reports);

		expect(reports.registrations).toHaveLength(1);
		expect(reports.registrations[0]!.moduleId).toBe('agents.core');
		const registered = reports.registrations[0]!.providers;
		expect(registered).toHaveLength(1);
		expect(registered[0]!.key).toBe(AGENT_RUNS_REPORT_PROVIDER_KEY);
		expect(registered[0]!.permission).toBe(AGENT_PERMISSIONS.runsRead);
	});

	it('composes without reports.core present', () => {
		const capabilities = createPlatformCapabilityRegistry();
		const composed = createServerComposition({
			environment: {
				FD_AGENT_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
				FD_AGENT_RUN_GRANT_KEY: Buffer.alloc(32, 8).toString('base64'),
			},
			workspaceRoot: process.cwd(),
			databases: database.databases,
			auth: {},
			agentTools: { register: () => undefined, list: () => [] },
			agentDefinitions: createPlatformAgentRegistry(),
			dataClasses: createDataClassRegistry().forModule('agents.core'),
			capabilities,
		} as unknown as PlatformServerContext);
		compositions.push(composed);

		expect(composed.routes.length).toBeGreaterThan(0);
	});

	it('counts only the days inside the range, as tiles and daily series', async () => {
		const service = await runtime();
		const agent = await activeAgent(service);
		const first = await settle(service, agent.id);
		const second = await settle(service, agent.id);
		const outside = await settle(service, agent.id);
		await moveRun(first, '2026-09-02');
		await moveRun(second, '2026-09-03');
		await moveRun(outside, '2026-01-15');

		const answer = await read();

		expect(answer.tiles).toEqual([
			{
				key: 'runs',
				label: 'Runs',
				tileLabelKey: AGENT_RUNS_REPORT_LABEL_KEYS.runs,
				value: 2,
				unit: 'runs',
			},
			{
				key: 'tokens',
				label: 'Tokens',
				tileLabelKey: AGENT_RUNS_REPORT_LABEL_KEYS.tokens,
				value: 28,
				unit: 'tokens',
			},
		]);
		expect(answer.series?.map((entry) => entry.key)).toEqual([
			'runs',
			'tokens',
		]);
		expect(answer.series?.[0]!.points).toEqual([
			{ at: '2026-09-02', value: 1 },
			{ at: '2026-09-03', value: 1 },
		]);
		expect(answer.series?.[1]!.points).toEqual([
			{ at: '2026-09-02', value: 14 },
			{ at: '2026-09-03', value: 14 },
		]);
	});

	it('reads only the workspace of the tenant it was handed', async () => {
		const service = await runtime();
		const mine = await activeAgent(service);
		const theirs = await activeAgent(service, OTHER);
		await moveRun(await settle(service, mine.id), '2026-09-02');
		await moveRun(await settle(service, theirs.id, OTHER), '2026-09-02', OTHER);

		expect((await read()).tiles[0]!.value).toBe(1);
		expect((await read(OTHER)).tiles[0]!.value).toBe(1);
		expect((await read('tenant-empty')).tiles).toEqual([
			{
				key: 'runs',
				label: 'Runs',
				tileLabelKey: AGENT_RUNS_REPORT_LABEL_KEYS.runs,
				value: 0,
				unit: 'runs',
			},
			{
				key: 'tokens',
				label: 'Tokens',
				tileLabelKey: AGENT_RUNS_REPORT_LABEL_KEYS.tokens,
				value: 0,
				unit: 'tokens',
			},
		]);
	});

	/* The workspace has runs to answer with, so a provider that ignored the
	   budget would answer its totals here instead of nothing. */
	it('answers nothing once the time budget has expired', async () => {
		const service = await runtime();
		const agent = await activeAgent(service);
		await moveRun(await settle(service, agent.id), '2026-09-02');
		expect((await read()).tiles[0]!.value).toBe(1);
		const controller = new AbortController();
		controller.abort();

		const answer = await createAgentRunsReportProvider(
			async () => database.repository,
		).read({
			tenantId: TENANT,
			principal: {
				accountId: ADA,
				tenantId: TENANT,
				scopes: [AGENT_PERMISSIONS.runsRead],
			},
			range: INSIDE,
			signal: controller.signal,
		});

		expect(answer.tiles).toEqual([]);
	});

	/* The budget has to reach the statement, not only the provider: a read the
	   reader has already been given up on must stop, not run to completion on a
	   connection nobody is waiting for. */
	it('hands the budget to the transaction and stops the statement it expires under', async () => {
		const controller = new AbortController();
		const recorder = abortingHandle(lease.database, () => controller.abort());
		const repository = new DatabaseAgentRepository({
			runtime: recorder.handle,
			background: recorder.handle,
		});

		await expect(
			createAgentRunsReportProvider(async () => repository).read({
				tenantId: TENANT,
				principal: {
					accountId: ADA,
					tenantId: TENANT,
					scopes: [AGENT_PERMISSIONS.runsRead],
				},
				range: INSIDE,
				signal: controller.signal,
			}),
		).rejects.toThrow(/abort/i);

		expect(recorder.asked).toHaveLength(1);
		expect(recorder.asked[0]?.signal).toBe(controller.signal);
		expect(recorder.asked[0]?.tenantId).toBe(TENANT);
		expect(recorder.asked[0]?.access).toBe('read');
	});

	it('names itself, its tiles and its lines with keys of its own bundle', () => {
		const provider = createAgentRunsReportProvider(async () => {
			throw new Error('the repository must not be opened');
		});
		const answer = runsAnswer([]);

		expect(provider.label).toBe(AGENT_RUNS_REPORT_PROVIDER_LABEL);
		expect(provider.labelKey).toBe(AGENT_RUNS_REPORT_LABEL_KEYS.provider);
		expect(answer.tiles.map((tile) => tile.tileLabelKey)).toEqual([
			AGENT_RUNS_REPORT_LABEL_KEYS.runs,
			AGENT_RUNS_REPORT_LABEL_KEYS.tokens,
		]);
		expect(answer.series?.map((entry) => entry.seriesLabelKey)).toEqual([
			AGENT_RUNS_REPORT_LABEL_KEYS.runsPerDay,
			AGENT_RUNS_REPORT_LABEL_KEYS.tokensPerDay,
		]);
	});

	/* reports.core resolves each key against this module's own bundle and falls
	   back to the English literal, so a locale that lacks one shows copy rather
	   than a raw key. */
	it('ships every report label key in every locale this module ships', () => {
		for (const qualified of Object.values(AGENT_RUNS_REPORT_LABEL_KEYS)) {
			const key = qualified.slice('agents.'.length);
			for (const bundle of [translationsEn, translationsPl]) {
				expect([key, key in bundle]).toEqual([key, true]);
			}
		}
	});
});

describe('agents runs answer', () => {
	it('sums runs and both token directions per day', () => {
		const answer = runsAnswer([
			{
				day: '2026-09-01',
				runs: 2,
				inputTokens: 10,
				outputTokens: 5,
				costMicroUsd: 0,
				unpricedRuns: 0,
			},
			{
				day: '2026-09-02',
				runs: 1,
				inputTokens: 7,
				outputTokens: 3,
				costMicroUsd: 0,
				unpricedRuns: 0,
			},
		]);

		expect(answer.tiles.map((tile) => tile.value)).toEqual([3, 25]);
		expect(answer.series?.[0]!.points.map((point) => point.value)).toEqual([
			2, 1,
		]);
		expect(answer.series?.[1]!.points.map((point) => point.value)).toEqual([
			15, 10,
		]);
	});

	it('answers zero totals and empty lines for a workspace with no runs', () => {
		const answer = runsAnswer([]);

		expect(answer.tiles.map((tile) => tile.value)).toEqual([0, 0]);
		expect(answer.series?.every((entry) => entry.points.length === 0)).toBe(
			true,
		);
	});
});
