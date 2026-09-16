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
	LocalSimulationProvider,
	type AgentNativeTool,
} from '@flowdular/harness';
import type { CreateAgentInput } from '../src/domain/types.ts';
import {
	createAgentRuntime,
	type AgentRuntime,
} from '../src/server/runtime.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const tenantId = 'tenant-native';
const member = 'member-native';
const NATIVE_ID = 'research.web-search';
const PERMISSION = 'research.run';

const definition: CreateAgentInput = {
	key: 'native-agent',
	name: 'Native search agent',
	description: 'Is granted a provider-executed web search.',
	instructions: 'Search the web and cite what you found.',
	provider: 'local-simulation',
	model: 'deterministic-v1',
	allowedTools: [NATIVE_ID],
	procedureIds: [],
	maxSteps: 2,
	timeoutMs: 1_000,
	temperature: 0,
	status: 'draft',
};

const nativeTool: AgentNativeTool = {
	id: NATIVE_ID,
	kind: 'web-search',
	config: {},
	requiredPermissions: [PERMISSION],
};

let database: AgentsTestDatabase;
const runtimes: AgentRuntime[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
});

beforeEach(async () => {
	await database.truncate();
});

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

afterAll(async () => {
	await database.dispose();
});

describe('agents.core native tools', () => {
	it('AGENTS-NATIVE-TOOL lets a definition allow a registered native tool and records its event on the run', async () => {
		const runtime = createAgentRuntime({
			databases: database.databases,
			workerConcurrency: 1,
			workerLeaseMs: 1_000,
			providers: [new LocalSimulationProvider()],
			providerHostAllowlist: new Set(),
			providerReadinessTtlMs: 10_000,
			providerReadinessTimeoutMs: 1_000,
			runGrantTtlMs: 10_000,
			environment: { NODE_ENV: 'test' },
			nativeTools: () => [nativeTool],
			authorizeToolAccess: () => [PERMISSION],
		});
		runtimes.push(runtime);
		const service = await runtime.service();
		expect(service.tools()).toContain(NATIVE_ID);
		runtime.start();
		const created = await service.createAgent(tenantId, member, definition);
		const agent = await service.updateAgent(tenantId, created.id, member, {
			...definition,
			status: 'active',
			expectedRevision: created.revision,
		});
		const queued = await service.enqueueRun(tenantId, member, [PERMISSION], {
			agentId: agent.id,
			trigger: 'service',
			input: 'acme insurance',
			toolGrants: [NATIVE_ID],
		});
		let status = queued.status;
		for (let attempt = 0; attempt < 400; attempt += 1) {
			status = (await service.getRun(tenantId, queued.id)).status;
			if (status === 'succeeded' || status === 'failed') break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const run = await service.getRun(tenantId, queued.id);
		expect(run.status).toBe('succeeded');
		expect(
			run.events
				.filter((event) => event.type === 'tool.native')
				.map((event) => event.metadata),
		).toEqual([{ tool: NATIVE_ID, reason: 'NATIVE_TOOL_UNSUPPORTED' }]);
	});
});
