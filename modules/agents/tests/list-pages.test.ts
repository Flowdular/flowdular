import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
import { AgentHarness, type AgentProvider } from '@flowdular/harness';
import type {
	AgentListQuery,
	AgentRunListQuery,
	CreateAgentInput,
} from '../src/domain/types.ts';
import { AgentService } from '../src/services/agent-service.ts';
import { AgentWorker } from '../src/services/worker.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const tenantId = 'tenant-pages';
const actor = 'owner-pages';

const provider: AgentProvider = {
	id: 'test-provider',
	execute: async () => ({
		output: 'done',
		usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		finishReason: 'stop',
	}),
};

function definition(name: string): CreateAgentInput {
	return {
		key: name.toLowerCase().replace(/[^a-z]/g, '') + '-agent',
		name,
		description: `Pages ${name}.`,
		instructions: 'Answer briefly and factually.',
		provider: 'test-provider',
		model: 'test-model',
		allowedTools: [],
		procedureIds: [],
		maxSteps: 2,
		timeoutMs: 5_000,
		temperature: 0,
		status: 'draft',
	};
}

/* Mixed case on purpose: the unbounded read orders by lower(name), and the
   pages have to walk that same collation rather than the raw bytes. */
const NAMES = ['beta', 'Alpha', 'gamma', 'Delta', 'epsilon', 'Zeta', 'eta'];

let database: AgentsTestDatabase;
const workers: AgentWorker[] = [];
let clock = 1_700_000_000_000;

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

/* The worker is never started, so every run stays queued where it was put. */
function service() {
	const harness = new AgentHarness({ providers: [provider] });
	const worker = new AgentWorker(database.repository, harness, {
		workerId: 'worker:pages',
		concurrency: 1,
		leaseMs: 1_000,
	});
	workers.push(worker);
	return new AgentService(
		database.repository,
		harness,
		worker,
		undefined,
		() => (clock += 1_000),
	);
}

async function agentPages(query: Omit<AgentListQuery, 'after'>) {
	const ids: string[] = [];
	let after: AgentListQuery['after'] = null;
	for (let guard = 0; guard < 10; guard += 1) {
		const page = await database.repository.listAgentsPage(tenantId, {
			...query,
			after,
		});
		ids.push(...page.agents.map((agent) => agent.id));
		if (page.agents.length < query.limit || page.last === null) break;
		after = {
			sortValue:
				query.sort === 'name' ? page.last.nameKey : page.last.updatedAt,
			id: page.last.id,
		};
	}
	return ids;
}

async function runPages(query: Omit<AgentRunListQuery, 'after'>) {
	const ids: string[] = [];
	let after: AgentRunListQuery['after'] = null;
	for (let guard = 0; guard < 10; guard += 1) {
		const runs = await database.repository.listRuns(tenantId, {
			...query,
			after,
		});
		ids.push(...runs.map((run) => run.id));
		const last = runs.at(-1);
		if (runs.length < query.limit || !last) break;
		after = { queuedAt: last.queuedAt, id: last.id };
	}
	return ids;
}

describe('agents list pages', () => {
	it('pages definitions in the order of the unbounded read', async () => {
		const agents = service();
		for (const name of NAMES) {
			await agents.createAgent(tenantId, actor, definition(name));
		}
		await agents.createAgent('tenant-elsewhere', actor, definition('Alpha'));
		const whole = await database.repository.listAgents(tenantId);
		expect(whole.map((agent) => agent.name)).toEqual([
			'Alpha',
			'beta',
			'Delta',
			'epsilon',
			'eta',
			'gamma',
			'Zeta',
		]);

		const byName = await agentPages({
			sort: 'name',
			direction: 'asc',
			search: null,
			limit: 3,
		});
		expect(byName).toEqual(whole.map((agent) => agent.id));
		const byNameDesc = await agentPages({
			sort: 'name',
			direction: 'desc',
			search: null,
			limit: 2,
		});
		expect(byNameDesc).toEqual([...whole].reverse().map((agent) => agent.id));

		const newestFirst = [...whole].sort(
			(left, right) =>
				right.updatedAt - left.updatedAt || right.id.localeCompare(left.id),
		);
		expect(
			await agentPages({
				sort: 'updatedAt',
				direction: 'desc',
				search: null,
				limit: 3,
			}),
		).toEqual(newestFirst.map((agent) => agent.id));

		expect(
			await agentPages({
				sort: 'name',
				direction: 'asc',
				search: 'TA',
				limit: 2,
			}),
		).toEqual(
			whole.filter((agent) => /ta/i.test(agent.name)).map((agent) => agent.id),
		);
		/* LIKE syntax typed by a reader is a literal, not a wildcard. */
		expect(
			await agentPages({
				sort: 'name',
				direction: 'asc',
				search: '%',
				limit: 5,
			}),
		).toEqual([]);
	});

	it('pages runs by queue time with the filters applied in SQL', async () => {
		const agents = service();
		const created = await agents.createAgent(
			tenantId,
			actor,
			definition('Runner'),
		);
		const runner = await agents.updateAgent(tenantId, created.id, actor, {
			...definition('Runner'),
			status: 'active',
			expectedRevision: created.revision,
		});
		const other = await agents.createAgent(
			tenantId,
			actor,
			definition('Other'),
		);
		const otherActive = await agents.updateAgent(tenantId, other.id, actor, {
			...definition('Other'),
			status: 'active',
			expectedRevision: other.revision,
		});
		const queued: string[] = [];
		for (let index = 0; index < 5; index += 1) {
			const run = await agents.enqueueRun(tenantId, actor, [], {
				agentId: index === 2 ? otherActive.id : runner.id,
				trigger: 'service',
				input: `Run ${index}`,
				toolGrants: [],
			});
			queued.push(run.id);
		}
		const newestFirst = [...queued].reverse();
		const base = {
			status: null,
			agentId: null,
			trigger: null,
			search: null,
		};

		expect(await runPages({ ...base, direction: 'desc', limit: 2 })).toEqual(
			newestFirst,
		);
		expect(await runPages({ ...base, direction: 'asc', limit: 2 })).toEqual(
			queued,
		);
		expect(
			await runPages({
				...base,
				direction: 'desc',
				limit: 2,
				status: 'queued',
			}),
		).toEqual(newestFirst);
		expect(
			await runPages({
				...base,
				direction: 'desc',
				limit: 2,
				status: 'succeeded',
			}),
		).toEqual([]);
		expect(
			await runPages({
				...base,
				direction: 'desc',
				limit: 2,
				agentId: otherActive.id,
			}),
		).toEqual([queued[2]]);
		/* The term matches the agent name; the run named Other stays out. */
		expect(
			await runPages({ ...base, direction: 'desc', limit: 2, search: 'run' }),
		).toEqual(newestFirst.filter((id) => id !== queued[2]));
		expect(
			await runPages({
				...base,
				direction: 'desc',
				limit: 2,
				search: queued[3]!,
			}),
		).toEqual([queued[3]]);
		expect(
			await runPages({
				...base,
				direction: 'desc',
				limit: 2,
				trigger: 'playground',
			}),
		).toEqual([]);
	});

	it('pages the audit trail newest first without a gap or an overlap', async () => {
		for (let index = 0; index < 5; index += 1) {
			await database.repository.appendAuditEvent({
				tenantId,
				actorId: actor,
				action: 'agent.updated',
				subjectType: 'agent',
				subjectId: `agent-${index}`,
				metadata: {},
				occurredAt: 1_000 + index,
			});
		}
		const whole = await database.repository.listAuditEvents(tenantId, 10);
		const paged: string[] = [];
		let after: { occurredAt: number; sequence: number } | null = null;
		for (let guard = 0; guard < 5; guard += 1) {
			const events = await database.repository.pageAuditEvents(tenantId, {
				limit: 2,
				after,
			});
			paged.push(...events.map((event) => event.id));
			const last = events.at(-1);
			if (events.length < 2 || !last) break;
			after = { occurredAt: last.occurredAt, sequence: last.sequence };
		}
		expect(paged).toEqual(whole.map((event) => event.id));
		expect(new Set(paged).size).toBe(5);
	});
});
