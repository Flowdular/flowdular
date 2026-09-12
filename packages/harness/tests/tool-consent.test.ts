import { describe, expect, it, vi } from 'vitest';
import { userActor } from '@flowdular/kernel';
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

describe('external risk ceiling', () => {
	it('refuses to build an api tool that declares external risk', () => {
		expect(() =>
			defineApiAgentTool({
				id: 'connectors.call',
				endpointId: 'connectors.calls.agent',
				description: 'An outbound call.',
				requiredPermissions: [PERMISSION],
				risk: 'external',
				execute: async () => ({}),
			}),
		).toThrow(/external risk/);
	});

	/* A hand-built tool object skips the adapter, so the harness refuses it at
	   the admission point as well: it is never offered and never runs. */
	it('never offers or runs a registered tool that declares external risk', async () => {
		const execute = vi.fn(async () => ({ ok: true }));
		const tool: AgentTool = {
			id: 'connectors.call',
			transport: 'api',
			target: 'connectors.calls.agent',
			description: 'An outbound call.',
			requiredPermissions: [PERMISSION],
			risk: 'external',
			execute,
		};
		const { provider, offered, failures } = caller();
		const result = await harnessWith(tool, provider).execute(request());

		expect(offered).toEqual([]);
		expect(failures).toEqual([{ code: 'TOOL_RISK_REFUSED' }]);
		expect(execute).not.toHaveBeenCalled();
		expect(
			result.events.find((event) => event.type === 'tool.denied')?.metadata,
		).toMatchObject({ reason: 'TOOL_RISK_REFUSED' });
	});
});
