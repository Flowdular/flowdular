import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	approvalInputDigest,
	createApprovalGrantKeyring,
	issueApprovalGrant,
	userActor,
	type ApprovalGrantKeyring,
} from '@flowdular/kernel';
import {
	AgentHarness,
	type AgentExecutionRequest,
	type AgentProvider,
	type AgentTool,
	type AgentToolConsentDecision,
	type AgentToolContext,
} from '../src/index.ts';
import { defineApiAgentTool } from '../src/tool-adapters.ts';

const PERMISSION = 'connectors.instances.read';

function request(
	overrides: Partial<AgentExecutionRequest> = {},
): AgentExecutionRequest {
	return {
		runId: 'run-1',
		tenantId: 'tenant-a',
		requestedBy: 'account-a',
		requestedActor: userActor({
			accountId: 'account-a',
			displayName: 'Ada',
			email: 'ada@example.com',
		}),
		trigger: 'playground',
		input: 'Fetch the open invoices.',
		definition: {
			id: 'agent-1',
			name: 'Billing helper',
			revision: 1,
			instructions: 'Call the connector and summarize the answer.',
			provider: 'calling-provider',
			model: 'deterministic-v1',
			allowedTools: ['connectors.call'],
			maxSteps: 4,
			timeoutMs: 1_000,
			temperature: 0,
		},
		permissionSnapshot: [PERMISSION],
		toolGrants: ['connectors.call'],
		...overrides,
	};
}

/** A provider that calls one tool and reports what happened. */
function caller(input: unknown = { instanceId: 'instance-1' }): {
	readonly provider: AgentProvider;
	readonly offered: string[];
	readonly failures: { code: string }[];
} {
	const offered: string[] = [];
	const failures: { code: string }[] = [];
	const provider: AgentProvider = {
		id: 'calling-provider',
		execute: async (context) => {
			offered.push(...context.availableTools.map((tool) => tool.id));
			try {
				await context.invokeTool('connectors.call', input);
			} catch (error) {
				failures.push({ code: (error as { code: string }).code });
			}
			return {
				output: 'done',
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				finishReason: 'stop',
			};
		},
	};
	return { provider, offered, failures };
}

function connectorTool(
	check: (
		input: unknown,
		context: AgentToolContext,
	) => Promise<AgentToolConsentDecision> | AgentToolConsentDecision,
	execute = vi.fn(async () => ({ ok: true })),
): { readonly tool: AgentTool; readonly execute: typeof execute } {
	const tool = defineApiAgentTool({
		id: 'connectors.call',
		endpointId: 'connectors.calls.agent',
		description: 'Call a consented connector instance.',
		requiredPermissions: [PERMISSION],
		risk: 'workspace-write',
		consent: { id: 'connectors.instance-consent', check },
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['instanceId'],
			properties: { instanceId: { type: 'string' } },
		},
		execute,
	});
	return { tool, execute };
}

function harnessWith(tool: AgentTool, provider: AgentProvider): AgentHarness {
	return new AgentHarness({
		providers: [provider],
		tools: [tool],
		authorizeToolAccess: () => [PERMISSION],
	});
}

describe('consent-gated tool admission', () => {
	it('runs a workspace-write tool when the module consents to this call', async () => {
		const { tool, execute } = connectorTool(() => ({ granted: true }));
		const { provider, offered, failures } = caller();
		const result = await harnessWith(tool, provider).execute(request());

		expect(offered).toEqual(['connectors.call']);
		expect(failures).toEqual([]);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(
			result.events.filter((event) => event.type === 'tool.completed').length,
		).toBe(1);
	});

	it('refuses the same tool when the module withholds consent, before execute', async () => {
		const { tool, execute } = connectorTool(() => ({
			granted: false,
			reason: 'CONNECTOR_CONSENT_MISSING',
		}));
		const { provider, offered, failures } = caller();
		const result = await harnessWith(tool, provider).execute(request());

		/* The tool is still offered: consent is a per-call answer, not a per-run
		   one, so the model may name it and be refused with a stable code. */
		expect(offered).toEqual(['connectors.call']);
		expect(failures).toEqual([{ code: 'CONNECTOR_CONSENT_MISSING' }]);
		expect(execute).not.toHaveBeenCalled();
		const denied = result.events.find((event) => event.type === 'tool.denied');
		expect(denied?.metadata).toMatchObject({
			tool: 'connectors.call',
			consent: 'connectors.instance-consent',
			reason: 'CONNECTOR_CONSENT_MISSING',
		});
		expect(result.events.some((event) => event.type === 'tool.started')).toBe(
			false,
		);
	});

	it('denies when the gate throws, and bounds a refusal code the module invents', async () => {
		const unavailable = connectorTool(() => {
			throw new Error('the module database is down');
		});
		const { provider, failures } = caller();
		await harnessWith(unavailable.tool, provider).execute(request());
		expect(failures).toEqual([{ code: 'TOOL_CONSENT_UNAVAILABLE' }]);
		expect(unavailable.execute).not.toHaveBeenCalled();

		const shouting = connectorTool(() => ({
			granted: false,
			reason: 'not a code; <script>',
		}));
		const second = caller();
		await harnessWith(shouting.tool, second.provider).execute(request());
		expect(second.failures).toEqual([{ code: 'TOOL_CONSENT_REFUSED' }]);
	});

	it('asks the gate with the run tenant and the already validated input', async () => {
		const seen: { input: unknown; tenantId: string; runId: string }[] = [];
		const { tool } = connectorTool((input, context) => {
			seen.push({
				input,
				tenantId: context.tenantId,
				runId: context.runId,
			});
			return { granted: true };
		});
		const { provider } = caller({ instanceId: 'instance-7' });
		await harnessWith(tool, provider).execute(request());
		expect(seen).toEqual([
			{
				input: { instanceId: 'instance-7' },
				tenantId: 'tenant-a',
				runId: 'run-1',
			},
		]);
	});

	/* A tool whose admission differs per caller kind reads the invocation kind
	   rather than assuming one. The workflow action runtime states the other
	   kind, so a gate that trusted the default would admit a workflow node on
	   the consent a workspace gave its agents. */
	it('names an agent run as the invocation kind, to the gate and to execute', async () => {
		const seen: (string | undefined)[] = [];
		const tool = defineApiAgentTool({
			id: 'connectors.call',
			endpointId: 'connectors.calls.agent',
			description: 'Call a consented connector instance.',
			requiredPermissions: [PERMISSION],
			risk: 'workspace-write',
			consent: {
				id: 'connectors.instance-consent',
				check: (_input, context) => {
					seen.push(context.invocation);
					return { granted: true };
				},
			},
			execute: async (_input, context) => {
				seen.push(context.invocation);
				return { ok: true };
			},
		});
		const { provider, failures } = caller();
		await harnessWith(tool, provider).execute(request());
		expect(failures).toEqual([]);
		expect(seen).toEqual(['agent-run', 'agent-run']);
	});

	it('refuses invalid input before the gate is asked', async () => {
		const check = vi.fn(() => ({ granted: true }));
		const { tool, execute } = connectorTool(check);
		const { provider, failures } = caller({ instanceId: 7 });
		await harnessWith(tool, provider).execute(request());
		expect(failures).toEqual([{ code: 'TOOL_INPUT_INVALID' }]);
		expect(check).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});

	it('runs a tool without a gate exactly as before', async () => {
		const execute = vi.fn(async () => ({ ok: true }));
		const tool = defineApiAgentTool({
			id: 'connectors.call',
			endpointId: 'connectors.calls.agent',
			description: 'An ungated read.',
			requiredPermissions: [PERMISSION],
			risk: 'read',
			execute,
		});
		const { provider, failures } = caller();
		await harnessWith(tool, provider).execute(request());
		expect(failures).toEqual([]);
		expect(execute).toHaveBeenCalledTimes(1);
	});
});

describe('consent gate identity', () => {
	/* The gate id reaches the denial event and the operator's trail, so it is
	   held to the same shape as the tool id at registration rather than being
	   trusted at the point it is emitted. */
	it('refuses a gate id that is not a lowercase dotted identifier', () => {
		for (const id of ['Connectors.Consent', 'connectors consent', '', '..']) {
			const { tool } = connectorTool(() => ({ granted: true }));
			const named: AgentTool = {
				...tool,
				consent: { id, check: tool.consent!.check },
			};
			expect(
				() =>
					new AgentHarness({
						providers: [],
						tools: [named],
						authorizeToolAccess: () => [PERMISSION],
					}),
			).toThrow(/tool.consent.id/);
		}
	});

	it('accepts the gate id the connectors module registers', () => {
		const { tool } = connectorTool(() => ({ granted: true }));
		expect(
			() =>
				new AgentHarness({
					providers: [],
					tools: [tool],
					authorizeToolAccess: () => [PERMISSION],
				}),
		).not.toThrow();
	});
});

const KEY_A = Buffer.alloc(32, 0x61);
const KEY_B = Buffer.alloc(32, 0x62);
const INPUT = { instanceId: 'instance-1' };

function externalTool(
	execute = vi.fn(async () => ({ ok: true })),
	consent?: AgentTool['consent'],
): { readonly tool: AgentTool; readonly execute: typeof execute } {
	const tool: AgentTool = {
		id: 'connectors.call',
		transport: 'api',
		target: 'connectors.calls.agent',
		description: 'An outbound call.',
		requiredPermissions: [PERMISSION],
		risk: 'external',
		...(consent ? { consent } : {}),
		execute,
	};
	return { tool, execute };
}

function grantFor(
	keyring: ApprovalGrantKeyring,
	overrides: { readonly input?: unknown; readonly expiresAt?: number } = {},
): string {
	const now = Date.now();
	return issueApprovalGrant(keyring, {
		tenantId: 'tenant-a',
		capabilityId: 'connectors.call',
		inputDigest: approvalInputDigest(overrides.input ?? INPUT),
		requestId: 'request-1',
		issuedAt: now - 1_000,
		expiresAt: overrides.expiresAt ?? now + 60_000,
		nonce: 'request-1',
	}).token;
}

function gatedHarness(tool: AgentTool, provider: AgentProvider): AgentHarness {
	return new AgentHarness({
		providers: [provider],
		tools: [tool],
		authorizeToolAccess: () => [PERMISSION],
		approvalGrants: createApprovalGrantKeyring({ current: KEY_A }),
	});
}

describe('external risk ceiling', () => {
	/* Building is not the gate: the adapter hands the harness the risk and the
	   harness admits the tool per run and per call. */
	it('builds an api tool that declares external risk', () => {
		expect(
			defineApiAgentTool({
				id: 'connectors.call',
				endpointId: 'connectors.calls.agent',
				description: 'An outbound call.',
				requiredPermissions: [PERMISSION],
				risk: 'external',
				execute: async () => ({}),
			}).risk,
		).toBe('external');
	});

	it('never offers or runs an external tool when the run carries no grant', async () => {
		const { tool, execute } = externalTool();
		const { provider, offered, failures } = caller();
		const result = await gatedHarness(tool, provider).execute(request());

		expect(offered).toEqual([]);
		expect(failures).toEqual([{ code: 'TOOL_RISK_REFUSED' }]);
		expect(execute).not.toHaveBeenCalled();
		expect(
			result.events.find((event) => event.type === 'tool.denied')?.metadata,
		).toMatchObject({ reason: 'TOOL_RISK_REFUSED' });
	});

	it('refuses an external tool without a configured key even with a grant', async () => {
		const { tool, execute } = externalTool();
		const { provider, offered, failures } = caller();
		const harness = new AgentHarness({
			providers: [provider],
			tools: [tool],
			authorizeToolAccess: () => [PERMISSION],
		});
		const token = grantFor(createApprovalGrantKeyring({ current: KEY_A }));
		await harness.execute(request({ grants: [token] }));

		expect(offered).toEqual([]);
		expect(failures).toEqual([{ code: 'TOOL_RISK_REFUSED' }]);
		expect(execute).not.toHaveBeenCalled();
	});

	it('refuses a grant signed under a foreign key or already expired', async () => {
		for (const [token, reason] of [
			[
				grantFor(createApprovalGrantKeyring({ current: KEY_B })),
				'APPROVAL_GRANT_INVALID',
			],
			[
				grantFor(createApprovalGrantKeyring({ current: KEY_A }), {
					expiresAt: Date.now() - 1,
				}),
				'APPROVAL_GRANT_EXPIRED',
			],
		] as const) {
			const { tool, execute } = externalTool();
			const { provider, offered, failures } = caller();
			const result = await gatedHarness(tool, provider).execute(
				request({ grants: [token] }),
			);

			expect(offered).toEqual([]);
			expect(failures).toEqual([{ code: 'TOOL_RISK_REFUSED' }]);
			expect(execute).not.toHaveBeenCalled();
			expect(
				result.events.find((event) => event.type === 'tool.denied')?.metadata,
			).toMatchObject({ reason: 'TOOL_RISK_REFUSED', grant: reason });
		}
	});

	it('records a mismatch when a token verifies for no tool of the run', async () => {
		const { tool, execute } = externalTool();
		const { provider, offered, failures } = caller();
		const token = issueApprovalGrant(
			createApprovalGrantKeyring({ current: KEY_A }),
			{
				tenantId: 'tenant-b',
				capabilityId: 'connectors.call',
				inputDigest: approvalInputDigest(INPUT),
				requestId: 'request-1',
				issuedAt: Date.now() - 1_000,
				expiresAt: Date.now() + 60_000,
				nonce: 'request-1',
			},
		).token;
		const result = await gatedHarness(tool, provider).execute(
			request({ grants: [token] }),
		);

		expect(offered).toEqual([]);
		expect(failures).toEqual([{ code: 'TOOL_RISK_REFUSED' }]);
		expect(execute).not.toHaveBeenCalled();
		expect(
			result.events.find((event) => event.type === 'tool.denied')?.metadata,
		).toMatchObject({
			reason: 'TOOL_RISK_REFUSED',
			grant: 'APPROVAL_GRANT_MISMATCH',
		});
	});

	it('admits one call per grant and refuses the repeat as consumed', async () => {
		const { tool, execute } = externalTool();
		const failures: { code: string }[] = [];
		const provider: AgentProvider = {
			id: 'calling-provider',
			execute: async (context) => {
				for (let attempt = 0; attempt < 2; attempt += 1) {
					try {
						await context.invokeTool('connectors.call', INPUT);
					} catch (error) {
						failures.push({ code: (error as { code: string }).code });
					}
				}
				return {
					output: 'done',
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					finishReason: 'stop',
				};
			},
		};
		const token = grantFor(createApprovalGrantKeyring({ current: KEY_A }));
		const result = await gatedHarness(tool, provider).execute(
			request({ grants: [token] }),
		);

		expect(execute).toHaveBeenCalledTimes(1);
		expect(failures).toEqual([{ code: 'TOOL_RISK_REFUSED' }]);
		expect(
			result.events.find((event) => event.type === 'tool.denied')?.metadata,
		).toMatchObject({
			reason: 'TOOL_RISK_REFUSED',
			grant: 'APPROVAL_GRANT_CONSUMED',
		});
	});

	it('refuses a grant issued for another input', async () => {
		const { tool, execute } = externalTool();
		const { provider, offered, failures } = caller();
		const token = grantFor(createApprovalGrantKeyring({ current: KEY_A }), {
			input: { instanceId: 'instance-2' },
		});
		const result = await gatedHarness(tool, provider).execute(
			request({ grants: [token] }),
		);

		expect(offered).toEqual(['connectors.call']);
		expect(failures).toEqual([{ code: 'TOOL_RISK_REFUSED' }]);
		expect(execute).not.toHaveBeenCalled();
		expect(
			result.events.find((event) => event.type === 'tool.denied')?.metadata,
		).toMatchObject({
			reason: 'TOOL_RISK_REFUSED',
			grant: 'APPROVAL_GRANT_MISMATCH',
		});
	});

	it('runs an external tool under a valid grant for this input', async () => {
		const { tool, execute } = externalTool();
		const { provider, offered, failures } = caller();
		const token = grantFor(createApprovalGrantKeyring({ current: KEY_A }));
		const result = await gatedHarness(tool, provider).execute(
			request({ grants: [token] }),
		);

		expect(offered).toEqual(['connectors.call']);
		expect(failures).toEqual([]);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(
			result.events
				.map((event) => event.type)
				.filter((type) => type.startsWith('tool.')),
		).toEqual(['tool.started', 'tool.completed']);
	});

	it('runs under a grant issued before the key was rotated', async () => {
		const { tool, execute } = externalTool();
		const { provider, failures } = caller();
		const token = grantFor(createApprovalGrantKeyring({ current: KEY_A }));
		const harness = new AgentHarness({
			providers: [provider],
			tools: [tool],
			authorizeToolAccess: () => [PERMISSION],
			approvalGrants: createApprovalGrantKeyring({
				current: KEY_B,
				previous: [KEY_A],
			}),
		});
		await harness.execute(request({ grants: [token] }));

		expect(failures).toEqual([]);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it('still asks the consent gate of a granted external tool', async () => {
		const { tool, execute } = externalTool(undefined, {
			id: 'connectors.instance-consent',
			check: () => ({ granted: false, reason: 'CONNECTOR_CONSENT_MISSING' }),
		});
		const { provider, offered, failures } = caller();
		const token = grantFor(createApprovalGrantKeyring({ current: KEY_A }));
		const result = await gatedHarness(tool, provider).execute(
			request({ grants: [token] }),
		);

		expect(offered).toEqual(['connectors.call']);
		expect(failures).toEqual([{ code: 'CONNECTOR_CONSENT_MISSING' }]);
		expect(execute).not.toHaveBeenCalled();
		expect(
			result.events.find((event) => event.type === 'tool.denied')?.metadata,
		).toMatchObject({
			consent: 'connectors.instance-consent',
			reason: 'CONNECTOR_CONSENT_MISSING',
		});
	});

	it('bounds the grants a run may carry', async () => {
		const { tool } = externalTool();
		const { provider } = caller();
		await expect(
			gatedHarness(tool, provider).execute(
				request({ grants: Array.from({ length: 17 }, () => 'ag1.x.y.z') }),
			),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
	});
});

describe('local-only ceiling', () => {
	const environment = {
		FD_ENV: process.env.FD_ENV,
		NODE_ENV: process.env.NODE_ENV,
	};

	afterEach(() => {
		for (const [key, value] of Object.entries(environment)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	function localTool(execute = vi.fn(async () => ({ ok: true }))) {
		const tool: AgentTool = {
			id: 'connectors.call',
			transport: 'cli',
			target: 'auth.greenfield.reset',
			description: 'Reset local authentication data.',
			requiredPermissions: [PERMISSION],
			risk: 'destructive',
			localOnly: true,
			execute,
		};
		return { tool, execute };
	}

	it('runs a granted local-only destructive capability in development', async () => {
		process.env.FD_ENV = 'development';
		const { tool, execute } = localTool();
		const { provider, offered, failures } = caller();
		const token = grantFor(createApprovalGrantKeyring({ current: KEY_A }));
		await gatedHarness(tool, provider).execute(request({ grants: [token] }));

		expect(offered).toEqual(['connectors.call']);
		expect(failures).toEqual([]);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it('never offers or runs it outside development and test, grant or not', async () => {
		process.env.FD_ENV = 'production';
		const { tool, execute } = localTool();
		const { provider, offered, failures } = caller();
		const token = grantFor(createApprovalGrantKeyring({ current: KEY_A }));
		const result = await gatedHarness(tool, provider).execute(
			request({ grants: [token] }),
		);

		expect(offered).toEqual([]);
		expect(failures).toEqual([{ code: 'TOOL_LOCAL_ONLY' }]);
		expect(execute).not.toHaveBeenCalled();
		expect(
			result.events.find((event) => event.type === 'tool.denied')?.metadata,
		).toMatchObject({ reason: 'TOOL_LOCAL_ONLY' });
	});
});
