import type { DatabaseAdapterLease } from '@flowdular/database';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import type {
	AgentTool,
	AgentToolAuthorizationRequest,
	AgentToolConsentDecision,
	AgentToolContext,
} from '@flowdular/harness';
import { defineApiAgentTool } from '@flowdular/harness/tool-adapters';
import {
	createAgentActionExecutionRuntime,
	type AgentActionRuntime,
} from '../src/server/action-execution.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const tenantId = 'tenant-consent';
const actor = {
	kind: 'user',
	id: 'owner-consent',
	label: 'Consent owner',
} as const;
const PERMISSION = 'connectors.instances.read';

const authorizeRead = (_request: AgentToolAuthorizationRequest) => [PERMISSION];

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

/**
 * The declaration connectors.core registers, built through the same adapter it
 * uses. agents.core must not import connectors.core (the tool reaches this
 * runtime as data, through the harness tool registry), so the fields are
 * restated here; modules/connectors/tests/agent-tools.test.ts pins them on the
 * owning side, and a drift there fails that suite.
 */
const CONNECTORS_CALL_DECLARATION = {
	id: 'connectors.call',
	endpointId: 'connectors.calls.agent',
	contractVersion: 1,
	description: 'Call a consented connector instance.',
	requiredPermissions: [PERMISSION],
	risk: 'workspace-write',
	idempotency: 'required',
	idempotencyProtection: 'target-ledger',
	cancellation: 'cooperative',
	inputSchema: {
		type: 'object',
		required: ['instanceId'],
		properties: { instanceId: { type: 'string' } },
		additionalProperties: false,
	},
	outputSchema: {
		type: 'object',
		required: ['ok'],
		properties: { ok: { type: 'boolean' } },
		additionalProperties: false,
	},
	timeoutMs: 1_000,
} as const;

/* A connector-shaped action: a complete workflow contract plus the run-time
   consent gate its module owns. */
function consentedAction(
	check: (
		input: unknown,
		context: AgentToolContext,
	) => Promise<AgentToolConsentDecision> | AgentToolConsentDecision,
	execute = vi.fn(async () => ({ ok: true })),
): { readonly tool: AgentTool; readonly execute: typeof execute } {
	return {
		execute,
		tool: defineApiAgentTool({
			...CONNECTORS_CALL_DECLARATION,
			requiredPermissions: [...CONNECTORS_CALL_DECLARATION.requiredPermissions],
			consent: { id: 'connectors.instance-consent', check },
			execute,
		}),
	};
}

let database: AgentsTestDatabase;
let owner: DatabaseAdapterLease;
const runtimes: AgentActionRuntime[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
	owner = await database.databases.acquire({
		namespace: 'agents.core',
		purpose: 'migration',
	});
});

beforeEach(async () => {
	await database.truncate();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

afterAll(async () => {
	await owner?.release();
	await database.dispose();
});

function trackedRuntime(tool: AgentTool, workerId: string): AgentActionRuntime {
	const runtime = createAgentActionExecutionRuntime(
		database.repository,
		[tool],
		{ workerId, leaseMs: 1_000, authorizeToolAccess: authorizeRead },
	);
	runtimes.push(runtime);
	return runtime;
}

function context(workflowRunId: string, nodeRunId = 'node-1') {
	return {
		tenantId,
		workflowRunId,
		nodeRunId,
		actor,
		permissionSnapshot: [PERMISSION],
		signal: new AbortController().signal,
	};
}

const request = {
	actionId: 'connectors.call',
	contractVersion: 1,
	input: { instanceId: 'instance-1' },
	idempotencyKey: 'workflow-run-consent:node-1',
} as const;

describe('the connector call as a workflow action', () => {
	/* Without every one of these fields descriptor() answers null, the action is
	   never published, and the workspace's allowWorkflows consent has nothing to
	   reach: the flag would be unreachable in production however it was set. */
	it('publishes the connector call with its contract', async () => {
		const { tool } = consentedAction(() => ({ granted: true }));
		const runtime = trackedRuntime(tool, 'action-worker:descriptor');
		expect(await runtime.capability.listWorkflowActions()).toEqual([
			expect.objectContaining({
				id: 'connectors.call',
				contractVersion: 1,
				risk: 'workspace-write',
				idempotency: 'required',
				cancellation: 'cooperative',
				requiredPermissions: [PERMISSION],
			}),
		]);
	});

	it('publishes nothing when any part of the contract is missing', async () => {
		const { tool } = consentedAction(() => ({ granted: true }));
		const incomplete: readonly (keyof AgentTool)[] = [
			'contractVersion',
			'outputSchema',
			'idempotency',
			'idempotencyProtection',
			'cancellation',
		];
		for (const field of incomplete) {
			const stripped = { ...tool } as Record<string, unknown>;
			delete stripped[field];
			const runtime = trackedRuntime(
				stripped as unknown as AgentTool,
				`action-worker:without-${String(field)}`,
			);
			expect([field, await runtime.capability.listWorkflowActions()]).toEqual([
				field,
				[],
			]);
		}
	});

	it('refuses to start an action it never published', async () => {
		const { tool } = consentedAction(() => ({ granted: true }));
		const stripped = { ...tool } as Record<string, unknown>;
		delete stripped.idempotencyProtection;
		const runtime = trackedRuntime(
			stripped as unknown as AgentTool,
			'action-worker:unpublished',
		);
		await expect(
			runtime.capability.start(request, context('workflow-run-unpublished')),
		).rejects.toMatchObject({ code: expect.any(String) });
	});
});

describe('consent-gated workflow actions', () => {
	it('refuses before the invocation is persisted when the module withholds consent', async () => {
		const { tool, execute } = consentedAction(() => ({
			granted: false,
			reason: 'CONNECTOR_CONSENT_MISSING',
		}));
		const runtime = trackedRuntime(tool, 'action-worker:refused');
		await expect(
			runtime.capability.start(request, context('workflow-run-consent')),
		).rejects.toMatchObject({ code: 'CONNECTOR_CONSENT_MISSING' });
		expect(execute).not.toHaveBeenCalled();
		expect(
			await database.repository.findActionByIdempotencyKey(
				tenantId,
				request.idempotencyKey,
			),
		).toBeNull();
	});

	it('accepts and runs the same action once the module consents', async () => {
		const seen: { tenantId: string; input: unknown }[] = [];
		const { tool, execute } = consentedAction((input, toolContext) => {
			seen.push({ tenantId: toolContext.tenantId, input });
			return { granted: true };
		});
		const runtime = trackedRuntime(tool, 'action-worker:granted');
		const accepted = await runtime.capability.start(
			request,
			context('workflow-run-consent'),
		);
		runtime.start();
		await waitFor(
			async () =>
				(
					await database.repository.getAction(
						tenantId,
						accepted.actionInvocationId,
					)
				)?.status === 'succeeded',
		);
		expect(execute).toHaveBeenCalledOnce();
		/* Once before the invocation is persisted, once before it runs. */
		expect(seen).toEqual([
			{ tenantId, input: { instanceId: 'instance-1' } },
			{ tenantId, input: { instanceId: 'instance-1' } },
		]);
	});

	/* A queued call must not reach the network after the workspace withdrew its
	   consent or disabled the instance. */
	it('fails a queued invocation whose consent was withdrawn after enqueue', async () => {
		let granted = true;
		const { tool, execute } = consentedAction(() =>
			granted
				? { granted: true }
				: { granted: false, reason: 'CONNECTOR_CONSENT_MISSING' },
		);
		const runtime = trackedRuntime(tool, 'action-worker:withdrawn');
		const accepted = await runtime.capability.start(
			request,
			context('workflow-run-consent'),
		);
		granted = false;
		runtime.start();
		await waitFor(
			async () =>
				(
					await database.repository.getAction(
						tenantId,
						accepted.actionInvocationId,
					)
				)?.status === 'failed',
		);
		expect(execute).not.toHaveBeenCalled();
		expect(
			await runtime.capability.getResult(accepted.actionInvocationId, {
				tenantId,
				workflowRunId: 'workflow-run-consent',
				actor,
				permissionSnapshot: [PERMISSION],
			}),
		).toMatchObject({
			status: 'failed',
			code: 'CONNECTOR_CONSENT_MISSING',
		});
	});

	/* The gate of a tool a workspace consents to per caller kind reads this and
	   nothing else: a workflow node admitted on the consent given to agents is
	   the failure this states away. */
	it('names a workflow action as the invocation kind, at the gate and at execution', async () => {
		const seen: (string | undefined)[] = [];
		const tool = defineApiAgentTool({
			...CONNECTORS_CALL_DECLARATION,
			requiredPermissions: [...CONNECTORS_CALL_DECLARATION.requiredPermissions],
			consent: {
				id: 'connectors.instance-consent',
				check: (_input, toolContext) => {
					seen.push(toolContext.invocation);
					return { granted: true };
				},
			},
			execute: async (_input, toolContext) => {
				seen.push(toolContext.invocation);
				return { ok: true };
			},
		});
		const runtime = trackedRuntime(tool, 'action-worker:invocation');
		const accepted = await runtime.capability.start(
			request,
			context('workflow-run-consent'),
		);
		runtime.start();
		await waitFor(
			async () =>
				(
					await database.repository.getAction(
						tenantId,
						accepted.actionInvocationId,
					)
				)?.status === 'succeeded',
		);
		/* The gate before the invocation is persisted, the gate before it runs,
		   then the tool itself. */
		expect(seen).toEqual([
			'workflow-action',
			'workflow-action',
			'workflow-action',
		]);
	});

	/* A workflow retrying a node it already enqueued must reach the invocation
	   it made, whatever the workspace decided since; the worker still asks the
	   gate again before that invocation runs. */
	it('answers a replayed key with the existing invocation after consent is withdrawn', async () => {
		let granted = true;
		const { tool, execute } = consentedAction(() =>
			granted
				? { granted: true }
				: { granted: false, reason: 'CONNECTOR_CONSENT_MISSING' },
		);
		const runtime = trackedRuntime(tool, 'action-worker:replayed');
		const first = await runtime.capability.start(
			request,
			context('workflow-run-consent'),
		);
		granted = false;
		expect(
			await runtime.capability.start(request, context('workflow-run-consent')),
		).toEqual({
			actionInvocationId: first.actionInvocationId,
			created: false,
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it('denies when the gate throws instead of letting the action run', async () => {
		const { tool, execute } = consentedAction(() => {
			throw new Error('the module database is down');
		});
		const runtime = trackedRuntime(tool, 'action-worker:unavailable');
		await expect(
			runtime.capability.start(request, context('workflow-run-consent')),
		).rejects.toMatchObject({ code: 'ACTION_CONSENT_UNAVAILABLE' });
		expect(execute).not.toHaveBeenCalled();
	});

	it('leaves an action without a gate untouched', async () => {
		const execute = vi.fn(async () => ({ ok: true }));
		const { tool } = consentedAction(() => ({ granted: true }), execute);
		const ungated: AgentTool = { ...tool };
		delete (ungated as { consent?: unknown }).consent;
		const runtime = trackedRuntime(ungated, 'action-worker:ungated');
		const accepted = await runtime.capability.start(
			request,
			context('workflow-run-consent'),
		);
		runtime.start();
		await waitFor(
			async () =>
				(
					await database.repository.getAction(
						tenantId,
						accepted.actionInvocationId,
					)
				)?.status === 'succeeded',
		);
		expect(execute).toHaveBeenCalledOnce();
	});
});
