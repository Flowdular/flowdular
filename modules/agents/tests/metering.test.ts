import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentHarness, type AgentProvider } from '@flowdular/harness';
import type { PlatformServerContext } from '@flowdular/module-auth/server';
import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import {
	createDataClassRegistry,
	createModuleRegistry,
	createPlatformAgentRegistry,
	createPlatformCapabilityRegistry,
	RegistryError,
} from '@flowdular/kernel';
import { moduleDefinition } from '../src/index.ts';
import { createServerComposition } from '../src/platform.ts';
import type { CreateAgentInput } from '../src/domain/types.ts';
import { AgentService } from '../src/services/agent-service.ts';
import { AgentWorker } from '../src/services/worker.ts';
import {
	AGENT_METERS,
	estimateRunTokens,
	METERING_METERS_CAPABILITY,
	METER_LIMIT_EXCEEDED,
	type MeterCheckInput,
	type MeterCheckResult,
	type MeterDeclaration,
	type MeterRecordInput,
	type MeterRegistry,
} from '../src/services/metering.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const TENANT = 'tenant-meters';
const ADA = 'account-ada';

const input: CreateAgentInput = {
	key: 'metered-agent',
	name: 'Metered agent',
	description: 'Reports what it consumed.',
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

/* The registry metering.core would register, with the calls this module made
   kept so a case can assert what it declared, checked and counted. */
class FakeMeterRegistry implements MeterRegistry {
	readonly declarations: {
		moduleId: string;
		meters: readonly MeterDeclaration[];
	}[] = [];
	readonly records: MeterRecordInput[] = [];
	readonly checks: MeterCheckInput[] = [];
	/** The answer for a named meter; every other one gets `verdict`. */
	readonly byMeter = new Map<string, MeterCheckResult>();
	verdict: MeterCheckResult = { verdict: 'allowed', used: 0, limit: null };

	declare(moduleId: string, meters: readonly MeterDeclaration[]): void {
		this.declarations.push({ moduleId, meters });
	}

	async record(record: MeterRecordInput) {
		this.records.push(record);
		return { recorded: true, day: '2026-09-11' };
	}

	async check(check: MeterCheckInput) {
		this.checks.push(check);
		return this.byMeter.get(check.meter) ?? this.verdict;
	}
}

function provider(totalTokens: number): AgentProvider {
	return {
		id: 'test-provider',
		execute: async () => ({
			output: 'done',
			usage: {
				inputTokens: totalTokens,
				outputTokens: 0,
				totalTokens,
			},
			finishReason: 'stop',
		}),
	};
}

let database: AgentsTestDatabase;
const workers: AgentWorker[] = [];
const compositions: { dispose?: () => unknown }[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
});

beforeEach(async () => {
	for (const worker of workers.splice(0)) await worker.dispose();
	await database.truncate();
});

afterAll(async () => {
	for (const worker of workers.splice(0)) await worker.dispose();
	for (const composed of compositions.splice(0)) await composed.dispose?.();
	await database.dispose();
});

function compose(meters?: FakeMeterRegistry) {
	const capabilities = createPlatformCapabilityRegistry();
	if (meters) capabilities.register(METERING_METERS_CAPABILITY, meters);
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

async function runtime(
	meters: FakeMeterRegistry,
	tokens = 7,
	now: () => number = Date.now,
) {
	const harness = new AgentHarness({ providers: [provider(tokens)] });
	const worker = new AgentWorker(database.repository, harness, {
		workerId: 'worker:meters',
		concurrency: 1,
		leaseMs: 1_000,
		meters: () => meters,
	});
	workers.push(worker);
	await worker.start();
	const service = new AgentService(
		database.repository,
		harness,
		worker,
		undefined,
		now,
		undefined,
		undefined,
		() => meters,
	);
	return { service, worker };
}

async function activeAgent(service: AgentService) {
	const created = await service.createAgent(TENANT, ADA, input);
	return service.updateAgent(TENANT, created.id, ADA, {
		...input,
		status: 'active',
		expectedRevision: created.revision,
	});
}

async function waitForTerminal(service: AgentService, runId: string) {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const run = await service.getRun(TENANT, runId);
		if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('The metered run did not finish in time.');
}

describe('agents.core metering', () => {
	it('declares its meters while the platform composes', () => {
		const meters = new FakeMeterRegistry();

		compose(meters);

		expect(meters.declarations).toEqual([
			{
				moduleId: 'agents.core',
				meters: [
					{
						key: 'run-tokens',
						label: 'Agent run tokens',
						unit: 'tokens',
						kind: 'cumulative',
					},
					{
						key: 'runs',
						label: 'Agent runs',
						unit: 'runs',
						kind: 'cumulative',
					},
				],
			},
		]);
	});

	it('counts a settled run once, keyed by the run id', async () => {
		const meters = new FakeMeterRegistry();
		const { service } = await runtime(meters, 11);
		const agent = await activeAgent(service);

		const queued = await service.enqueueRun(TENANT, ADA, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Count me.',
			toolGrants: [],
		});
		const settled = await waitForTerminal(service, queued.id);

		expect(settled.status).toBe('succeeded');
		expect(meters.records).toEqual([
			{
				tenantId: TENANT,
				meter: AGENT_METERS.runs,
				amount: 1,
				sourceRef: queued.id,
			},
			{
				tenantId: TENANT,
				meter: AGENT_METERS.runTokens,
				amount: 11,
				sourceRef: queued.id,
			},
		]);
	});

	it('counts the run but no tokens when the run never reported any', async () => {
		const meters = new FakeMeterRegistry();
		const { service } = await runtime(meters, 0);
		const agent = await activeAgent(service);

		const queued = await service.enqueueRun(TENANT, ADA, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Count me.',
			toolGrants: [],
		});
		await waitForTerminal(service, queued.id);

		expect(meters.records.map((record) => record.meter)).toEqual([
			AGENT_METERS.runs,
		]);
	});

	it('counts a run that failed, because it consumed the provider too', async () => {
		const meters = new FakeMeterRegistry();
		const harness = new AgentHarness({
			providers: [
				{
					id: 'test-provider',
					execute: async () => {
						throw new Error('The provider refused.');
					},
				},
			],
		});
		const worker = new AgentWorker(database.repository, harness, {
			workerId: 'worker:failing',
			concurrency: 1,
			leaseMs: 1_000,
			meters: () => meters,
		});
		workers.push(worker);
		await worker.start();
		const service = new AgentService(
			database.repository,
			harness,
			worker,
			undefined,
			Date.now,
			undefined,
			undefined,
			() => meters,
		);
		const agent = await activeAgent(service);

		const queued = await service.enqueueRun(TENANT, ADA, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Fail me.',
			toolGrants: [],
		});
		const settled = await waitForTerminal(service, queued.id);

		expect(settled.status).toBe('failed');
		expect(meters.records).toEqual([
			{
				tenantId: TENANT,
				meter: AGENT_METERS.runs,
				amount: 1,
				sourceRef: queued.id,
			},
		]);
	});

	/* A run costs the workspace a run and the tokens it may read and write, so
	   both meters are asked before the run exists. Asking for the tokens alone
	   let a workspace whose run allowance was spent keep starting runs. */
	it('checks the run and the token allowance before the run exists', async () => {
		const meters = new FakeMeterRegistry();
		const { service } = await runtime(meters);
		const agent = await activeAgent(service);

		await service.enqueueRun(TENANT, ADA, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Check me.',
			toolGrants: [],
		});

		expect(meters.checks).toEqual([
			{ tenantId: TENANT, meter: AGENT_METERS.runs, amount: 1 },
			{
				tenantId: TENANT,
				meter: AGENT_METERS.runTokens,
				amount: estimateRunTokens({
					instructions: input.instructions,
					input: 'Check me.',
					maxOutputTokens: 4_096,
				}),
			},
		]);
	});

	describe('AGENTS-METER-RUNS-LIMIT', () => {
		it('refuses the run when the workspace has used its run allowance', async () => {
			const meters = new FakeMeterRegistry();
			const { service } = await runtime(meters);
			const agent = await activeAgent(service);
			meters.byMeter.set(AGENT_METERS.runs, {
				verdict: 'refused',
				used: 50,
				limit: 50,
			});

			await expect(
				service.enqueueRun(TENANT, ADA, [], {
					agentId: agent.id,
					trigger: 'service',
					input: 'Refuse me.',
					toolGrants: [],
				}),
			).rejects.toMatchObject({ code: METER_LIMIT_EXCEEDED, status: 409 });

			expect(await service.listRuns(TENANT)).toEqual([]);
			/* The run meter is asked first, so a workspace out of runs is never also
			   measured against the token allowance. */
			expect(meters.checks.map((check) => check.meter)).toEqual([
				AGENT_METERS.runs,
			]);
			expect(
				(await database.repository.listAuditEvents(TENANT, 10))[0],
			).toMatchObject({
				action: 'agent-run.meter-refused',
				metadata: { meter: AGENT_METERS.runs, amount: 1, limit: 50 },
			});
		});
	});

	it('refuses the run start and records the refusal in the agent trail', async () => {
		const meters = new FakeMeterRegistry();
		const { service } = await runtime(meters);
		const agent = await activeAgent(service);
		meters.byMeter.set(AGENT_METERS.runTokens, {
			verdict: 'refused',
			used: 1_000,
			limit: 1_000,
		});

		await expect(
			service.enqueueRun(TENANT, ADA, [], {
				agentId: agent.id,
				trigger: 'service',
				input: 'Refuse me.',
				toolGrants: [],
			}),
		).rejects.toMatchObject({ code: METER_LIMIT_EXCEEDED, status: 409 });

		expect(await service.listRuns(TENANT)).toEqual([]);
		expect(meters.records).toEqual([]);
		const refusal = (await database.repository.listAuditEvents(TENANT, 10))[0];
		expect(refusal).toMatchObject({
			action: 'agent-run.meter-refused',
			actorId: ADA,
			subjectId: agent.id,
			metadata: {
				code: METER_LIMIT_EXCEEDED,
				meter: AGENT_METERS.runTokens,
				used: 1_000,
				limit: 1_000,
			},
		});
		/* The refusal is a link of the same chain the trail is verified on. */
		expect(await database.repository.verifyAuditChain(TENANT)).toBe(true);
	});

	describe('AGENTS-METER-REFUSAL-ONCE', () => {
		/* A refusal stands until the month turns or the limit is raised, so the
		   chained trail records it once. A caller retrying a refused enqueue wrote
		   the same fact to the chain as fast as it could ask. */
		it('records one refusal for a workspace, a meter and a month however often it is retried', async () => {
			const meters = new FakeMeterRegistry();
			let now = Date.UTC(2026, 8, 11, 12, 0, 0);
			const { service } = await runtime(meters, 7, () => now);
			const agent = await activeAgent(service);
			meters.byMeter.set(AGENT_METERS.runTokens, {
				verdict: 'refused',
				used: 1_000,
				limit: 1_000,
			});
			const enqueue = () =>
				service.enqueueRun(TENANT, ADA, [], {
					agentId: agent.id,
					trigger: 'service',
					input: 'Refuse me.',
					toolGrants: [],
				});

			for (let attempt = 0; attempt < 5; attempt += 1) {
				await expect(enqueue()).rejects.toMatchObject({
					code: METER_LIMIT_EXCEEDED,
				});
			}

			const refusals = async () =>
				(await database.repository.listAuditEvents(TENANT, 50)).filter(
					(event) => event.action === 'agent-run.meter-refused',
				);
			expect((await refusals()).length).toBe(1);
			/* Every attempt still asked metering.core, so the workspace is refused on
			   what its month actually holds rather than on a remembered verdict. */
			expect(
				meters.checks.filter((check) => check.meter === AGENT_METERS.runTokens)
					.length,
			).toBe(5);

			/* The next month is a new allowance, so its first refusal is recorded. */
			now = Date.UTC(2026, 9, 1, 0, 0, 0);
			await expect(enqueue()).rejects.toMatchObject({
				code: METER_LIMIT_EXCEEDED,
			});
			expect((await refusals()).length).toBe(2);
			expect(await database.repository.verifyAuditChain(TENANT)).toBe(true);
		});
	});

	it('starts the run on a warning verdict', async () => {
		const meters = new FakeMeterRegistry();
		const { service } = await runtime(meters);
		const agent = await activeAgent(service);
		meters.verdict = { verdict: 'warning', used: 900, limit: 1_000 };

		const queued = await service.enqueueRun(TENANT, ADA, [], {
			agentId: agent.id,
			trigger: 'service',
			input: 'Warn me.',
			toolGrants: [],
		});

		expect((await waitForTerminal(service, queued.id)).status).toBe(
			'succeeded',
		);
	});
});

/* metering.core is a dependency of agents.core, not an option: the meters are
   what a workspace's run allowance is enforced against, so a deployment that
   composes agents.core without it must be refused at composition rather than
   run unmetered. */
describe('AGENTS-METERING-REQUIRED', () => {
	function stub(
		id: string,
		version: string,
		provides: readonly string[] = [],
	): RegisteredModule {
		return {
			manifest: {
				schemaVersion: 1,
				id,
				package: `@flowdular/module-${id.split('.')[0]}`,
				version,
				profile: 'full',
				capabilities: ['api'],
				dependencies: [],
				provides: [...provides],
				tenancy: 'required',
				locales: ['en'],
				stability: 'experimental',
			} as ModuleManifest,
		};
	}

	const platform = [stub('system.core', '0.5.1'), stub('auth.core', '0.12.0')];
	const metering = stub('metering.core', '0.1.3', ['metering.meters.v1']);

	it('refuses a composition that leaves metering.core out', () => {
		expect(() => createModuleRegistry([...platform, moduleDefinition])).toThrow(
			RegistryError,
		);
		try {
			createModuleRegistry([...platform, moduleDefinition]);
			expect.unreachable(
				'The registry accepted a composition without metering.core.',
			);
		} catch (error) {
			expect(error).toMatchObject({ code: 'MODULE_DEPENDENCY_MISSING' });
		}
	});

	it('refuses a composition where nothing provides the meter registry', () => {
		try {
			createModuleRegistry([
				...platform,
				stub('metering.core', '0.1.3'),
				moduleDefinition,
			]);
			expect.unreachable(
				'The registry accepted a composition with no meter registry.',
			);
		} catch (error) {
			expect(error).toMatchObject({ code: 'MODULE_CAPABILITY_MISSING' });
		}
	});

	it('composes metering.core before agents.core', () => {
		const registry = createModuleRegistry([
			...platform,
			metering,
			moduleDefinition,
		]);

		const order = registry.modules.map((entry) => entry.manifest.id);
		expect(order.indexOf('metering.core')).toBeLessThan(
			order.indexOf('agents.core'),
		);
	});
});
