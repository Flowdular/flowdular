import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentToolContext } from '@flowdular/harness/runtime';
import { CONNECTORS_PERMISSIONS } from '../src/acl/permissions.ts';
import { connectorsAgentTools } from '../src/agent/tools.ts';
import { createConnectorsRuntime } from '../src/server/runtime.ts';
import type { ConnectorsRuntime } from '../src/server/runtime.ts';
import {
	openConnectorsTestDatabase,
	type ConnectorsTestDatabase,
} from './support/database.ts';
import {
	TEST_DEFINITION_KEY,
	TEST_LIMITS,
	portedTestDefinition,
	instanceService,
	seedInstance,
	startTestServer,
	testBaseUrl,
	testConnect,
	testResolver,
	testVault,
	type TestServer,
} from './support/harness.ts';

const TENANT = 'tenant-agent';

let shared: ConnectorsTestDatabase;
let server: TestServer;

beforeAll(async () => {
	shared = await openConnectorsTestDatabase();
	server = await startTestServer((request) => ({
		body: JSON.stringify({ ok: true, url: request.url }),
	}));
});

afterAll(async () => {
	await server?.close();
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

function runtime(): ConnectorsRuntime {
	const created = createConnectorsRuntime({
		databases: shared.databases,
		repository: shared.repository,
		vault: testVault(),
		limits: () => TEST_LIMITS,
		hostResolver: testResolver(),
		connect: testConnect(),
	});
	/* The shipped generic definition accepts 443 only, so the suite registers a
	   definition for the port its own server opened, as a module would. */
	created.definitions.register(portedTestDefinition());
	return created;
}

let keySequence = 0;

function context(
	tenantId: string,
	idempotencyKey = `agent-tool-key-${++keySequence}`,
): AgentToolContext {
	return {
		runId: 'run-0001',
		tenantId,
		requestedBy: 'account-ada',
		permissions: new Set<string>(),
		idempotencyKey,
		signal: new AbortController().signal,
	};
}

/* What the workflow action runtime hands the tool: the same context, with the
   invocation kind it states. */
function workflowContext(
	tenantId: string,
	idempotencyKey = `workflow-action-key-${++keySequence}`,
): AgentToolContext {
	return {
		...context(tenantId, idempotencyKey),
		invocation: 'workflow-action',
	};
}

describe('connectors agent tool', () => {
	/* Every field agents.core's descriptor() requires. Drop any one of them and
	   the call stops being publishable as a workflow action, which would leave
	   the workspace's allowWorkflows consent unreachable in production. */
	it('declares the whole workflow action contract and the consent gate', () => {
		const [tool] = connectorsAgentTools(runtime());
		expect(tool).toMatchObject({
			id: 'connectors.call',
			transport: 'api',
			target: 'connectors.calls.agent',
			contractVersion: 1,
			risk: 'workspace-write',
			idempotency: 'required',
			idempotencyProtection: 'target-ledger',
			cancellation: 'cooperative',
			requiredPermissions: [CONNECTORS_PERMISSIONS.read],
		});
		expect(tool!.consent?.id).toBe('connectors.instance-consent');
		expect(tool!.inputSchema).toMatchObject({ type: 'object' });
		expect(tool!.outputSchema).toMatchObject({ type: 'object' });
	});

	it('refuses to run without the durable key its ledger needs', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			definitionKey: TEST_DEFINITION_KEY,
			baseUrl: testBaseUrl(server),
			allowAgents: true,
		});
		const [tool] = connectorsAgentTools(runtime());
		const before = server.requests.length;
		await expect(
			tool!.execute(
				{ instanceId: instance.id, operation: 'get', input: { path: '/x' } },
				context(TENANT, ''),
			),
		).rejects.toMatchObject({ code: 'CONNECTOR_IDEMPOTENCY_KEY_REQUIRED' });
		expect(server.requests.length).toBe(before);
	});

	it('answers a repeat of the same run key without calling again', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			definitionKey: TEST_DEFINITION_KEY,
			baseUrl: testBaseUrl(server),
			allowAgents: true,
		});
		const [tool] = connectorsAgentTools(runtime());
		const input = {
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/things' },
		};
		const before = server.requests.length;
		const first = (await tool!.execute(
			input,
			context(TENANT, 'run-0001-call-1'),
		)) as Record<string, unknown>;
		const second = (await tool!.execute(
			input,
			context(TENANT, 'run-0001-call-1'),
		)) as Record<string, unknown>;
		expect(first).toMatchObject({ outcome: 'succeeded', replayed: false });
		expect(second).toMatchObject({
			callId: first.callId,
			outcome: 'succeeded',
			replayed: true,
		});
		expect(server.requests.length).toBe(before + 1);
	});

	it('grants the gate only for an active instance with agent consent', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			definitionKey: TEST_DEFINITION_KEY,
			baseUrl: testBaseUrl(server),
		});
		const service = instanceService(shared.repository, vault);
		const [tool] = connectorsAgentTools(runtime());
		const gate = tool!.consent!;

		expect(
			await gate.check({ instanceId: instance.id }, context(TENANT)),
		).toEqual({ granted: false, reason: 'CONNECTOR_CONSENT_MISSING' });
		expect(await gate.check({}, context(TENANT))).toEqual({
			granted: false,
			reason: 'CONNECTOR_INSTANCE_UNKNOWN',
		});

		await service.consent(TENANT, 'account-ada', instance.id, {
			allowWorkflows: false,
			allowAgents: true,
			confirmed: true,
		});
		expect(
			await gate.check({ instanceId: instance.id }, context(TENANT)),
		).toEqual({ granted: true });
		/* Another workspace never satisfies the gate for this instance. */
		expect(
			await gate.check({ instanceId: instance.id }, context('tenant-other')),
		).toEqual({ granted: false, reason: 'CONNECTOR_CONSENT_MISSING' });

		await service.disable(TENANT, 'account-ada', instance.id);
		expect(
			await gate.check({ instanceId: instance.id }, context(TENANT)),
		).toEqual({ granted: false, reason: 'CONNECTOR_CONSENT_MISSING' });
	});

	it('calls under the run tenant and ignores a tenant in the input', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			definitionKey: TEST_DEFINITION_KEY,
			baseUrl: testBaseUrl(server),
			allowAgents: true,
		});
		await seedInstance(shared.repository, vault, {
			tenantId: 'tenant-other',
			definitionKey: TEST_DEFINITION_KEY,
			baseUrl: testBaseUrl(server),
			allowAgents: true,
		});
		const [tool] = connectorsAgentTools(runtime());
		const result = (await tool!.execute(
			{
				instanceId: instance.id,
				operation: 'get',
				input: { path: '/things' },
				tenantId: 'tenant-other',
			},
			context(TENANT),
		)) as Record<string, unknown>;

		expect(result).toMatchObject({
			outcome: 'succeeded',
			status: 200,
			bodyOmitted: false,
		});
		const service = instanceService(shared.repository, vault);
		const [logged] = await service.listCalls(TENANT);
		expect(logged).toMatchObject({
			caller: 'agent',
			callerRef: 'run-0001',
			instanceId: instance.id,
		});
		expect(await service.listCalls('tenant-other')).toEqual([]);
	});

	/* The gate is the admission; the service refuses again so a caller that
	   reaches execute directly cannot skip the consent. */
	it('throws a stable refusal when the instance has no agent consent', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			definitionKey: TEST_DEFINITION_KEY,
			baseUrl: testBaseUrl(server),
		});
		const [tool] = connectorsAgentTools(runtime());
		const before = server.requests.length;
		await expect(
			tool!.execute(
				{ instanceId: instance.id, operation: 'get', input: { path: '/x' } },
				context(TENANT),
			),
		).rejects.toMatchObject({ code: 'CONNECTOR_CALL_REFUSED' });
		expect(server.requests.length).toBe(before);
	});

	it('hands back a failed call as data instead of throwing', async () => {
		const failing = await startTestServer(() => ({
			status: 404,
			body: '{"error":"absent"}',
		}));
		try {
			const vault = testVault();
			const instance = await seedInstance(shared.repository, vault, {
				tenantId: TENANT,
				definitionKey: TEST_DEFINITION_KEY,
				baseUrl: testBaseUrl(failing),
				allowAgents: true,
			});
			const [tool] = connectorsAgentTools(runtime());
			const result = (await tool!.execute(
				{ instanceId: instance.id, operation: 'get', input: { path: '/x' } },
				context(TENANT),
			)) as Record<string, unknown>;
			expect(result).toMatchObject({
				outcome: 'failed',
				status: 404,
				errorClass: 'response-4xx',
			});
		} finally {
			await failing.close();
		}
	});

	it('omits a body too large for one run window instead of truncating it', async () => {
		const large = await startTestServer(() => ({
			body: JSON.stringify({ blob: 'x'.repeat(20_000) }),
		}));
		try {
			const vault = testVault();
			const instance = await seedInstance(shared.repository, vault, {
				tenantId: TENANT,
				definitionKey: TEST_DEFINITION_KEY,
				baseUrl: testBaseUrl(large),
				allowAgents: true,
			});
			const [tool] = connectorsAgentTools(runtime());
			const result = (await tool!.execute(
				{ instanceId: instance.id, operation: 'get', input: { path: '/x' } },
				context(TENANT),
			)) as Record<string, unknown>;
			expect(result).toMatchObject({ bodyOmitted: true, body: null });
		} finally {
			await large.close();
		}
	});
});

describe('CONNECTORS-TOOL-CALLER-KIND', () => {
	/* The workspace consents per caller kind, so the flag that admits the call is
	   the one for the kind the caller states. A workflow node running on the
	   consent a workspace gave its agents, or the reverse, is what this pins. */
	it('admits a workflow action on allowWorkflows only, and logs it as one', async () => {
		const vault = testVault();
		const forWorkflows = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			definitionKey: TEST_DEFINITION_KEY,
			baseUrl: testBaseUrl(server),
			allowWorkflows: true,
			allowAgents: false,
		});
		const forAgents = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			definitionKey: TEST_DEFINITION_KEY,
			baseUrl: testBaseUrl(server),
			allowWorkflows: false,
			allowAgents: true,
		});
		const [tool] = connectorsAgentTools(runtime());
		const gate = tool!.consent!;

		expect(
			await gate.check(
				{ instanceId: forWorkflows.id },
				workflowContext(TENANT),
			),
		).toEqual({ granted: true });
		expect(
			await gate.check({ instanceId: forWorkflows.id }, context(TENANT)),
		).toEqual({ granted: false, reason: 'CONNECTOR_CONSENT_MISSING' });
		expect(
			await gate.check({ instanceId: forAgents.id }, workflowContext(TENANT)),
		).toEqual({ granted: false, reason: 'CONNECTOR_CONSENT_MISSING' });

		const result = (await tool!.execute(
			{ instanceId: forWorkflows.id, operation: 'get', input: { path: '/w' } },
			workflowContext(TENANT),
		)) as Record<string, unknown>;
		expect(result).toMatchObject({ outcome: 'succeeded', status: 200 });
		const service = instanceService(shared.repository, vault);
		expect((await service.listCalls(TENANT))[0]).toMatchObject({
			caller: 'workflow',
			instanceId: forWorkflows.id,
		});

		/* The gate is the admission; the service refuses the mirror state again. */
		await expect(
			tool!.execute(
				{ instanceId: forAgents.id, operation: 'get', input: { path: '/w' } },
				workflowContext(TENANT),
			),
		).rejects.toMatchObject({ code: 'CONNECTOR_CALL_REFUSED' });
	});
});
