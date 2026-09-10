import type { DatabaseProvider } from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
import { AgentHarness, LocalSimulationProvider } from '@flowdular/harness';
import { defineAgent } from '../src/server/define-agent.ts';
import { preflightModuleAgentDefinitions } from '../src/services/module-agent-preflight.ts';
import { AgentService } from '../src/services/agent-service.ts';
import { AgentWorker } from '../src/services/worker.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

function definition(revision: number, name = `Catalog curator ${revision}`) {
	return defineAgent({
		moduleId: 'catalog.core',
		key: 'catalog-curator',
		definitionRevision: revision,
		name,
		description: 'Reviews and normalizes catalog records.',
		instructions: 'Use only the catalog tools explicitly granted to this run.',
		allowedTools: ['catalog.item.read'],
		limits: {
			maxSteps: 8,
			timeoutMs: 120_000,
			temperature: 0.2,
			maxOutputTokens: 4_096,
		},
	});
}

let database: AgentsTestDatabase;
const workers: AgentWorker[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
});

afterEach(async () => {
	for (const worker of workers.splice(0)) await worker.dispose();
});

beforeEach(async () => {
	await database.truncate();
});

afterAll(async () => {
	await database.dispose();
});

function service() {
	const harness = new AgentHarness({
		providers: [new LocalSimulationProvider()],
	});
	const worker = new AgentWorker(database.repository, harness, {
		workerId: 'worker:module-agent-preflight',
		concurrency: 1,
		leaseMs: 1_000,
	});
	workers.push(worker);
	return new AgentService(database.repository, harness, worker);
}

async function registered(revision: number) {
	await database.repository.reconcileModuleAgents(
		[definition(revision)],
		Date.now(),
	);
}

describe('module agent boot preflight', () => {
	it('accepts an unchanged or newer definition and writes nothing', async () => {
		await registered(2);

		expect(
			await preflightModuleAgentDefinitions(database.databases, [
				definition(2),
			]),
		).toHaveLength(1);
		expect(
			await preflightModuleAgentDefinitions(database.databases, [
				definition(3),
			]),
		).toHaveLength(1);

		/* The check is read only: the durable catalog still names revision 2, so
		   revision 2 is still accepted rather than reported as a downgrade from
		   the 3 the previous call passed. */
		expect(
			await preflightModuleAgentDefinitions(database.databases, [
				definition(2),
			]),
		).toHaveLength(1);
	});

	it('rejects drift and downgrade using the persisted high-water revision', async () => {
		await registered(2);

		await expect(
			preflightModuleAgentDefinitions(database.databases, []),
		).resolves.toEqual([]);
		await expect(
			preflightModuleAgentDefinitions(database.databases, [definition(1)]),
		).rejects.toThrow(/MODULE_AGENT_REVISION_DOWNGRADE/);
		await expect(
			preflightModuleAgentDefinitions(database.databases, [
				definition(2, 'Changed in place'),
			]),
		).rejects.toThrow(/MODULE_AGENT_REVISION_DRIFT/);
	});

	it('treats a database with no catalog yet as a first run, not a downgrade', async () => {
		const bare: DatabaseProvider = createPgliteTestProvider();
		try {
			expect(
				await preflightModuleAgentDefinitions(bare, [definition(1)]),
			).toHaveLength(1);
		} finally {
			await bare.dispose();
		}
		expect(
			await preflightModuleAgentDefinitions(undefined, [definition(1)]),
		).toHaveLength(1);
	});

	it('keeps transactional reconciliation as a race-condition defense', async () => {
		/* This generation passed its boot check against an empty catalog. */
		expect(
			await preflightModuleAgentDefinitions(database.databases, [
				definition(2),
			]),
		).toHaveLength(1);
		/* A competing process registered a newer revision in between. */
		await registered(3);

		await expect(
			service().reconcileModuleAgents([definition(2)]),
		).rejects.toThrow(/MODULE_AGENT_REVISION_DOWNGRADE/);
	});
});
