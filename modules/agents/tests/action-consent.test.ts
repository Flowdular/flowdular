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
import {
	LocalSimulationProvider,
	type AgentTool,
	type AgentToolAuthorizationRequest,
	type AgentToolConsentDecision,
	type AgentToolContext,
} from '@flowdular/harness';
import {
	defineApiAgentTool,
	defineCliAgentTool,
} from '@flowdular/harness/tool-adapters';
import {
	createAgentActionExecutionRuntime,
	type AgentActionRuntime,
} from '../src/server/action-execution.ts';
import { createAgentRuntime } from '../src/server/runtime.ts';
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
 * A connector-shaped action built through the same adapter connectors.core
 * uses. agents.core must not import connectors.core: the tool reaches this
 * runtime through the harness registry. Its contract version and governance
 * fields mirror the current connector action; the small schemas keep these
 * tests focused on consent and the action ledger. The owning module tests its
 * complete declaration.
 */
const CONNECTORS_CALL_DECLARATION = {
	id: 'connectors.call',
	endpointId: 'connectors.calls.agent',
	contractVersion: 2,
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
	try {
		for (const runtime of runtimes.splice(0)) await runtime.dispose();
	} finally {
		vi.unstubAllEnvs();
	}
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
	contractVersion: 2,
	input: { instanceId: 'instance-1' },
	idempotencyKey: 'workflow-run-consent:node-1',
} as const;

function localCliAction(execute = vi.fn(async () => ({ ok: true }))) {
	return {
		execute,
		tool: defineCliAgentTool({
			id: 'local.preview',
			capability: { id: 'local.preview', risk: 'read', localOnly: true },
			description: 'Preview a local capability.',
			requiredPermissions: [PERMISSION],
			risk: 'read',
			idempotency: 'required',
			cancellation: 'cooperative',
			contractVersion: 1,
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
			execute,
		}),
	};
}

describe('local-only CLI workflow actions', () => {
	const localRequest = {
		actionId: 'local.preview',
		contractVersion: 1,
		input: { instanceId: 'instance-1' },
		idempotencyKey: 'workflow-local:node-1',
	} as const;

	it('keeps a complete local-only tool out of both catalogs in production', async () => {
		vi.stubEnv('FD_ENV', 'production');
		const { tool, execute } = localCliAction();
		const runtime = trackedRuntime(tool, 'action-worker:local-production');
		expect(await runtime.capability.listWorkflowActions()).toEqual([]);
		expect(await runtime.capabilityV2.listWorkflowActions()).toEqual([]);
		await expect(
			runtime.capabilityV2.start(localRequest, context('workflow-local')),
		).rejects.toMatchObject({ code: 'ACTION_VERSION_MISSING' });
		expect(execute).not.toHaveBeenCalled();
	});

	it('refuses a queued local-only action if the worker now runs in production', async () => {
		vi.stubEnv('FD_ENV', 'test');
		const { tool, execute } = localCliAction();
		const runtime = trackedRuntime(tool, 'action-worker:local-recovered');
		expect(await runtime.capabilityV2.listWorkflowActions()).toHaveLength(1);
		const accepted = await runtime.capabilityV2.start(
			localRequest,
			context('workflow-local-recovered'),
		);
		vi.stubEnv('FD_ENV', 'production');
		expect(await runtime.capabilityV2.listWorkflowActions()).toEqual([]);
		runtime.start();
		await waitFor(
			async () =>
				(
					await runtime.capabilityV2.getResult(
						accepted.actionInvocationId,
						context('workflow-local-recovered'),
					)
				)?.status === 'failed',
		);
		expect(
			await runtime.capabilityV2.getResult(
				accepted.actionInvocationId,
				context('workflow-local-recovered'),
			),
		).toMatchObject({ status: 'failed', code: 'TOOL_LOCAL_ONLY' });
		expect(execute).not.toHaveBeenCalled();
	});
});

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
				contractVersion: 2,
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

describe('AGENTS-WORKFLOW-TEMPLATE-CATALOG', () => {
	it('exposes static template metadata only through v2 and shares the invocation ledger', async () => {
		const execute = vi.fn(async () => ({ ok: true }));
		const tool = defineApiAgentTool({
			...CONNECTORS_CALL_DECLARATION,
			requiredPermissions: [...CONNECTORS_CALL_DECLARATION.requiredPermissions],
			workflowTemplate: {
				label: 'Call service',
				description: 'Call a consented service operation.',
				effect: 'connector-egress',
			},
			execute,
		});
		const runtime = trackedRuntime(tool, 'action-worker:template-catalog');
		const legacy = (await runtime.capability.listWorkflowActions())[0]!;
		const current = (await runtime.capabilityV2.listWorkflowActions())[0]!;
		expect(legacy).not.toHaveProperty('workflowTemplate');
		expect(legacy).not.toHaveProperty('idempotencyProtection');
		expect(current).toMatchObject({
			id: legacy.id,
			contractVersion: legacy.contractVersion,
			timeoutMs: 1_000,
			idempotencyProtection: 'target-ledger',
			workflowTemplate: {
				label: 'Call service',
				effect: 'connector-egress',
			},
		});
		(current.workflowTemplate as { label: string }).label = 'Changed by caller';
		(current.requiredPermissions as string[]).push('unexpected.permission');
		expect((await runtime.capabilityV2.listWorkflowActions())[0]).toMatchObject(
			{
				requiredPermissions: [PERMISSION],
				workflowTemplate: { label: 'Call service' },
			},
		);
		const accepted = await runtime.capabilityV2.start(
			request,
			context('workflow-run-template'),
		);
		runtime.start();
		await waitFor(
			async () =>
				(
					await runtime.capability.getResult(
						accepted.actionInvocationId,
						context('workflow-run-template'),
					)
				)?.status === 'succeeded',
		);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(
			await runtime.capability.getResult(
				accepted.actionInvocationId,
				context('workflow-run-template'),
			),
		).toMatchObject({ status: 'succeeded', output: { ok: true } });
	});

	it('keeps an eligible action without a template in the generic catalogue', async () => {
		const { tool } = consentedAction(() => ({ granted: true }));
		const runtime = trackedRuntime(tool, 'action-worker:generic-catalog');
		expect(await runtime.capabilityV2.listWorkflowActions()).toEqual([
			expect.objectContaining({
				id: 'connectors.call',
				contractVersion: 2,
				idempotencyProtection: 'target-ledger',
			}),
		]);
		expect(
			(await runtime.capabilityV2.listWorkflowActions())[0],
		).not.toHaveProperty('workflowTemplate');
	});
});

describe('AGENTS-WORKFLOW-TEMPLATE-REJECT', () => {
	function registrationCode(tool: AgentTool): string | undefined {
		try {
			createAgentActionExecutionRuntime(database.repository, [tool]);
			return undefined;
		} catch (error) {
			return (error as { code?: string }).code;
		}
	}

	it('refuses a nested secret value in an output schema before catalog publication', () => {
		const tool = defineApiAgentTool({
			...CONNECTORS_CALL_DECLARATION,
			requiredPermissions: [...CONNECTORS_CALL_DECLARATION.requiredPermissions],
			outputSchema: {
				anyOf: [
					{ type: 'object', properties: { ok: { type: 'boolean' } } },
					{
						type: 'object',
						properties: {
							token: {
								type: 'string',
								'x-flowdular-secret': true,
								example: 'secret-must-not-enter-catalog',
							},
						},
					},
				],
			},
			execute: async () => ({ ok: true }),
		});
		expect(registrationCode(tool)).toBe('ACTION_SCHEMA_SECRET_VALUE');
		expect(
			registrationCode({
				...tool,
				outputSchema: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							token: {
								type: 'string',
								'x-flowdular-secret': true,
								default: 'secret-must-not-enter-catalog',
							},
						},
					},
				},
			}),
		).toBe('ACTION_SCHEMA_SECRET_VALUE');
		expect(
			registrationCode({
				...tool,
				outputSchema: { type: 'string', writeOnly: true, enum: [] },
			}),
		).toBe('ACTION_SCHEMA_SECRET_VALUE');
	});

	it('refuses secret values embedded in a parent schema example or default', () => {
		const base = defineApiAgentTool({
			...CONNECTORS_CALL_DECLARATION,
			requiredPermissions: [...CONNECTORS_CALL_DECLARATION.requiredPermissions],
			execute: async () => ({ ok: true }),
		});
		expect(
			registrationCode({
				...base,
				outputSchema: {
					type: 'object',
					properties: {
						token: { type: 'string', 'x-flowdular-secret': true },
					},
					default: { token: 'credential-leak' },
				},
			}),
		).toBe('ACTION_SCHEMA_SECRET_VALUE');
		expect(
			registrationCode({
				...base,
				inputSchema: {
					type: 'array',
					items: {
						type: 'object',
						properties: { token: { type: 'string', writeOnly: true } },
					},
					examples: [[{ token: 'credential-leak' }]],
				},
			}),
		).toBe('ACTION_SCHEMA_SECRET_VALUE');
		expect(
			registrationCode({
				...base,
				inputSchema: {
					type: 'object',
					properties: {
						token: { type: 'string', 'x-flowdular-secret': true },
					},
					examples: { first: { token: 'credential-leak' } },
				},
			}),
		).toBe('ACTION_SCHEMA_SECRET_VALUE');
		expect(
			registrationCode({
				...base,
				outputSchema: {
					type: 'object',
					properties: { token: { $ref: '#/$defs/secret' } },
					$defs: { secret: { type: 'string', writeOnly: true } },
					example: { token: 'credential-leak' },
				},
			}),
		).toBe('ACTION_SCHEMA_SECRET_VALUE');
		expect(
			registrationCode({
				...base,
				inputSchema: {
					type: 'array',
					items: [{ type: 'string' }],
					additionalItems: { type: 'string', 'x-flowdular-secret': true },
					default: ['safe', 'credential-leak'],
				},
			}),
		).toBe('ACTION_SCHEMA_SECRET_VALUE');
	});

	it('refuses a template schema keyword outside the workflow graph subset', () => {
		const tool = defineApiAgentTool({
			...CONNECTORS_CALL_DECLARATION,
			requiredPermissions: [...CONNECTORS_CALL_DECLARATION.requiredPermissions],
			inputSchema: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					token: { type: 'string', 'x-flowdular-secret': true },
				},
				default: { id: 'safe-reference' },
			},
			workflowTemplate: {
				label: 'Safe lookup',
				description: 'Uses an optional secret field only outside a graph.',
				effect: 'local',
			},
			execute: async () => ({ ok: true }),
		});
		expect(registrationCode(tool)).toBe('ACTION_TEMPLATE_SCHEMA_UNSUPPORTED');
		expect(
			registrationCode({
				...tool,
				inputSchema: {
					type: 'object',
					properties: { id: { type: 'string', pattern: '^[A-Z]+$' } },
				},
			}),
		).toBe('ACTION_TEMPLATE_SCHEMA_UNSUPPORTED');
		expect(
			registrationCode({
				...tool,
				inputSchema: {
					type: 'object',
					'x-flowdular-read-permission': 'records.read',
				},
			}),
		).toBe('ACTION_TEMPLATE_SCHEMA_UNSUPPORTED');
		expect(
			registrationCode({
				...tool,
				inputSchema: {
					type: 'object',
					description: 'x'.repeat(17_000),
				},
			}),
		).toBe('ACTION_TEMPLATE_SCHEMA_UNSUPPORTED');
		expect(
			registrationCode({
				...tool,
				outputSchema: { type: 'object', description: 'x'.repeat(17_000) },
			}),
		).toBe('ACTION_TEMPLATE_SCHEMA_UNSUPPORTED');
		expect(
			registrationCode({
				...tool,
				inputSchema: {
					type: 'object',
					properties: { selection: { enum: [{ id: 'one' }] } },
				},
			}),
		).toBe('ACTION_TEMPLATE_SCHEMA_UNSUPPORTED');
	});

	it('refuses a template that requires a raw secret input', () => {
		const tool = defineApiAgentTool({
			...CONNECTORS_CALL_DECLARATION,
			requiredPermissions: [...CONNECTORS_CALL_DECLARATION.requiredPermissions],
			inputSchema: {
				type: 'object',
				required: ['token'],
				properties: { token: { type: 'string', writeOnly: true } },
			},
			workflowTemplate: {
				label: 'Unsafe call',
				description: 'Requires a secret from a workflow.',
				effect: 'connector-egress',
			},
			execute: async () => ({ ok: true }),
		});
		expect(registrationCode(tool)).toBe('ACTION_TEMPLATE_SECRET_INPUT');
	});

	it('refuses a template whose allOf branch requires a secret property', () => {
		const tool = defineApiAgentTool({
			...CONNECTORS_CALL_DECLARATION,
			requiredPermissions: [...CONNECTORS_CALL_DECLARATION.requiredPermissions],
			inputSchema: {
				type: 'object',
				properties: {
					token: { type: 'string', 'x-flowdular-secret': true },
				},
				allOf: [{ required: ['token'] }],
			},
			workflowTemplate: {
				label: 'Unsafe call',
				description: 'Requires a secret from a workflow.',
				effect: 'connector-egress',
			},
			execute: async () => ({ ok: true }),
		});
		expect(registrationCode(tool)).toBe('ACTION_TEMPLATE_SECRET_INPUT');
	});

	it('fails closed for conditional secret requirements the tool validator cannot prove', () => {
		const base = defineApiAgentTool({
			...CONNECTORS_CALL_DECLARATION,
			requiredPermissions: [...CONNECTORS_CALL_DECLARATION.requiredPermissions],
			workflowTemplate: {
				label: 'Conditional call',
				description: 'Has a conditional secret input.',
				effect: 'local',
			},
			execute: async () => ({ ok: true }),
		});
		const properties = {
			id: { type: 'string' },
			token: { type: 'string', 'x-flowdular-secret': true },
		};
		for (const conditional of [
			{ anyOf: [{ required: ['token'] }, { required: ['id'] }] },
			{ dependentSchemas: { id: { required: ['token'] } } },
			{ dependentRequired: { id: ['token'] } },
		]) {
			expect(
				registrationCode({
					...base,
					inputSchema: {
						type: 'object',
						properties,
						required: ['id'],
						...conditional,
					},
				}),
			).toBe('ACTION_TEMPLATE_SECRET_SCHEMA_UNPROVEN');
		}
	});

	it('refuses malformed metadata rather than publishing an unusable palette entry', () => {
		const tool = defineApiAgentTool({
			...CONNECTORS_CALL_DECLARATION,
			requiredPermissions: [...CONNECTORS_CALL_DECLARATION.requiredPermissions],
			workflowTemplate: {
				label: ' ',
				description: 'A description.',
				effect: 'local',
			},
			execute: async () => ({ ok: true }),
		});
		expect(registrationCode(tool)).toBe('ACTION_TEMPLATE_INVALID');
	});

	it('refuses a duplicate template identity and an external-risk template', () => {
		const tool = defineApiAgentTool({
			...CONNECTORS_CALL_DECLARATION,
			requiredPermissions: [...CONNECTORS_CALL_DECLARATION.requiredPermissions],
			workflowTemplate: {
				label: 'Call service',
				description: 'Call a consented service operation.',
				effect: 'connector-egress',
			},
			execute: async () => ({ ok: true }),
		});
		expect(() =>
			createAgentActionExecutionRuntime(database.repository, [tool, tool]),
		).toThrowError(
			expect.objectContaining({ code: 'ACTION_TEMPLATE_DUPLICATE' }),
		);
		expect(registrationCode({ ...tool, risk: 'external' })).toBe(
			'ACTION_TEMPLATE_INELIGIBLE',
		);
	});

	it('fails platform preparation before publishing invalid template metadata', async () => {
		const tool = defineApiAgentTool({
			...CONNECTORS_CALL_DECLARATION,
			requiredPermissions: [...CONNECTORS_CALL_DECLARATION.requiredPermissions],
			workflowTemplate: {
				label: ' ',
				description: 'Invalid template.',
				effect: 'local',
			},
			execute: async () => ({ ok: true }),
		});
		const runtime = createAgentRuntime({
			databases: database.databases,
			workerConcurrency: 1,
			workerLeaseMs: 1_000,
			providers: [new LocalSimulationProvider()],
			providerHostAllowlist: new Set(),
			providerReadinessTtlMs: 10_000,
			providerReadinessTimeoutMs: 1_000,
			runGrantTtlMs: 1_000,
			environment: { NODE_ENV: 'test' },
			tools: [tool],
		});
		try {
			await expect(runtime.prepare()).rejects.toMatchObject({
				code: 'ACTION_TEMPLATE_INVALID',
			});
		} finally {
			await runtime.dispose();
		}
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
