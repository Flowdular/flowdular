import { describe, expect, it, vi } from 'vitest';
import {
	AgentHarness,
	AgentHarnessError,
	LocalSimulationProvider,
	type AgentExecutionRequest,
	type AgentProvider,
	type AgentTool,
} from '../src/index.ts';

function request(
	overrides: Partial<AgentExecutionRequest> = {},
): AgentExecutionRequest {
	return {
		runId: 'run-1',
		tenantId: 'tenant-a',
		requestedBy: 'account-a',
		trigger: 'playground',
		input: 'Draft a customer follow-up.',
		definition: {
			id: 'agent-1',
			name: 'Customer helper',
			revision: 1,
			instructions: 'Prepare a concise, factual response for review.',
			provider: 'local-simulation',
			model: 'deterministic-v1',
			allowedTools: [],
			maxSteps: 4,
			timeoutMs: 1_000,
			temperature: 0,
		},
		permissionSnapshot: ['parties.records.read'],
		toolGrants: [],
		...overrides,
	};
}

describe('agent runtime harness', () => {
	it('executes through a registered provider and records ordered events', async () => {
		const harness = new AgentHarness({
			providers: [new LocalSimulationProvider()],
		});
		const result = await harness.execute(request());
		expect(result.output).toContain('No external model or network was called.');
		expect(result.events.map((event) => event.sequence)).toEqual([
			1, 2, 3, 4, 5,
		]);
		expect(
			result.events.some((event) => event.type === 'provider.output.delta'),
		).toBe(true);
		expect(result.events.at(-1)?.type).toBe('run.completed');
	});

	it('keeps whitespace-only output deltas instead of failing the run', async () => {
		const provider: AgentProvider = {
			id: 'streamer',
			execute: async (context) => {
				for (const chunk of ['Hello', '\n\n', 'world', '']) {
					context.emit('provider.output.delta', chunk);
				}
				return {
					output: 'Hello\n\nworld',
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					finishReason: 'stop',
				};
			},
		};
		const harness = new AgentHarness({ providers: [provider] });
		const result = await harness.execute(
			request({
				definition: { ...request().definition, provider: 'streamer' },
			}),
		);
		const deltas = result.events
			.filter((event) => event.type === 'provider.output.delta')
			.map((event) => event.message);
		expect(deltas).toEqual(['Hello', '\n\n', 'world']);
		expect(result.events.map((event) => event.sequence)).toEqual(
			result.events.map((_, index) => index + 1),
		);
	});

	it('aborts the provider when the caller signal fires', async () => {
		const provider: AgentProvider = {
			id: 'slow',
			execute: (context) =>
				new Promise((_, reject) => {
					context.signal.addEventListener('abort', () =>
						reject(
							new AgentHarnessError(
								'EXECUTION_ABORTED',
								String(context.signal.reason),
							),
						),
					);
				}),
		};
		const harness = new AgentHarness({ providers: [provider] });
		const controller = new AbortController();
		const pending = harness.execute(
			request({
				definition: {
					...request().definition,
					provider: 'slow',
					timeoutMs: 10_000,
				},
			}),
			{ signal: controller.signal },
		);
		controller.abort('lease-lost');
		await expect(pending).rejects.toMatchObject({
			code: 'EXECUTION_ABORTED',
			message: 'lease-lost',
		});
	});

	it('exposes a tool only when definition, run grant, and RBAC scope agree', async () => {
		const execute = vi.fn(async () => ({ customer: 'Ada' }));
		const tool: AgentTool = {
			id: 'parties.customer.read',
			transport: 'api',
			target: 'parties.records.get',
			description: 'Read one customer.',
			requiredPermissions: ['parties.records.read'],
			execute,
		};
		const provider: AgentProvider = {
			id: 'tool-test',
			execute: async (context) => {
				await context.invokeTool('parties.customer.read', { id: 'customer-1' });
				return {
					output: 'done',
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					finishReason: 'stop',
				};
			},
		};
		const harness = new AgentHarness({ providers: [provider], tools: [tool] });
		await harness.execute(
			request({
				definition: {
					...request().definition,
					provider: 'tool-test',
					allowedTools: ['parties.customer.read'],
				},
				toolGrants: ['parties.customer.read'],
			}),
		);
		expect(execute).toHaveBeenCalledOnce();
	});

	it('denies a tool when its required RBAC scope is absent', async () => {
		const tool: AgentTool = {
			id: 'parties.customer.read',
			transport: 'api',
			target: 'parties.records.get',
			description: 'Read one customer.',
			requiredPermissions: ['parties.records.read'],
			execute: async () => ({}),
		};
		const provider: AgentProvider = {
			id: 'tool-test',
			execute: async (context) => {
				await context.invokeTool('parties.customer.read', {});
				return {
					output: 'done',
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					finishReason: 'stop',
				};
			},
		};
		const harness = new AgentHarness({ providers: [provider], tools: [tool] });
		await expect(
			harness.execute(
				request({
					definition: {
						...request().definition,
						provider: 'tool-test',
						allowedTools: ['parties.customer.read'],
					},
					permissionSnapshot: [],
					toolGrants: ['parties.customer.read'],
				}),
			),
		).rejects.toMatchObject({
			code: 'TOOL_NOT_GRANTED',
		} satisfies Partial<AgentHarnessError>);
	});
});
