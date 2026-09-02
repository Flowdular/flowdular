import { describe, expect, it } from 'vitest';
import {
	AgentHarness,
	AgentHarnessError,
	MAX_TOOL_OUTPUT_CHARACTERS,
	type AgentExecutionEvent,
	type AgentExecutionRequest,
	type AgentProvider,
	type AgentTool,
} from '../src/index.ts';
import { userActor } from '@coreloom/kernel';

const TOOL_ID = 'parties.customer.read';

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
		input: 'Look up the customer.',
		definition: {
			id: 'agent-1',
			name: 'Customer helper',
			revision: 1,
			instructions: 'Prepare a concise, factual response for review.',
			provider: 'tool-test',
			model: 'deterministic-v1',
			allowedTools: [TOOL_ID],
			maxSteps: 4,
			timeoutMs: 5_000,
			temperature: 0,
		},
		permissionSnapshot: ['parties.records.read'],
		toolGrants: [TOOL_ID],
		...overrides,
	};
}

function tool(overrides: Partial<AgentTool> = {}): AgentTool {
	return {
		id: TOOL_ID,
		transport: 'api',
		target: 'parties.records.get',
		description: 'Read one customer.',
		requiredPermissions: ['parties.records.read'],
		inputSchema: {
			type: 'object',
			required: ['id'],
			properties: { id: { type: 'string' } },
			additionalProperties: false,
		},
		execute: async () => ({ customer: 'Ada' }),
		...overrides,
	};
}

const authorizeToolAccess = () => ['parties.records.read'];

/* The provider forwards whatever the tool call produced, including its
   failure, so the test can observe both the events and the error. */
function providerCalling(
	input: unknown,
	onResult?: (value: unknown) => void,
): AgentProvider {
	return {
		id: 'tool-test',
		execute: async (context) => {
			let failure: unknown = null;
			try {
				const value = await context.invokeTool(TOOL_ID, input);
				onResult?.(value);
			} catch (error) {
				failure = error;
			}
			return {
				output: failure instanceof Error ? failure.message : 'done',
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				finishReason: 'stop',
			};
		},
	};
}

function types(events: readonly AgentExecutionEvent[]): readonly string[] {
	return events.map((event) => event.type);
}

describe('harness tool contract', () => {
	it('refuses input that does not match the tool schema and records the denial', async () => {
		let executed = false;
		const harness = new AgentHarness({
			providers: [providerCalling({ id: 42, extra: true })],
			authorizeToolAccess,
			tools: [
				tool({
					execute: async () => {
						executed = true;
						return {};
					},
				}),
			],
		});
		const result = await harness.execute(request());
		expect(executed).toBe(false);
		expect(result.output).toMatch(/Tool input id must be of type string/);
		const denied = result.events.find((event) => event.type === 'tool.denied');
		expect(denied?.metadata).toMatchObject({
			tool: TOOL_ID,
			reason: 'TOOL_INPUT_INVALID',
		});
		expect(types(result.events)).not.toContain('tool.started');
	});

	it('accepts input the schema allows and passes it to the tool', async () => {
		let received: unknown;
		const harness = new AgentHarness({
			providers: [providerCalling({ id: 'customer-1' })],
			authorizeToolAccess,
			tools: [
				tool({
					execute: async (input) => {
						received = input;
						return { customer: 'Ada' };
					},
				}),
			],
		});
		const result = await harness.execute(request());
		expect(received).toEqual({ id: 'customer-1' });
		expect(types(result.events)).toEqual([
			'run.started',
			'provider.started',
			'tool.started',
			'tool.completed',
			'provider.completed',
			'run.completed',
		]);
	});

	it('times out a slow tool, aborts its signal, and records the failure', async () => {
		let aborted = false;
		const harness = new AgentHarness({
			providers: [providerCalling({ id: 'customer-1' })],
			authorizeToolAccess,
			tools: [
				tool({
					timeoutMs: 250,
					execute: (_input, context) =>
						new Promise((resolve) => {
							context.signal.addEventListener('abort', () => {
								aborted = true;
								resolve({});
							});
						}),
				}),
			],
		});
		const result = await harness.execute(request());
		expect(aborted).toBe(true);
		expect(result.output).toMatch(/exceeded 250 ms/);
		expect(
			result.events.find((event) => event.type === 'tool.failed')?.metadata,
		).toMatchObject({ tool: TOOL_ID, reason: 'TOOL_TIMEOUT' });
	});

	it('turns a throwing tool into a stable failure without crashing the run', async () => {
		const harness = new AgentHarness({
			providers: [providerCalling({ id: 'customer-1' })],
			authorizeToolAccess,
			tools: [
				tool({
					execute: async () => {
						throw new TypeError('database is on fire');
					},
				}),
			],
		});
		const result = await harness.execute(request());
		expect(result.output).toBe('database is on fire');
		expect(
			result.events.find((event) => event.type === 'tool.failed')?.metadata,
		).toMatchObject({ tool: TOOL_ID, reason: 'TOOL_EXECUTION_FAILED' });
	});

	it('bounds oversized tool output with a marker and reports the cut', async () => {
		let forwarded: unknown;
		const harness = new AgentHarness({
			providers: [
				providerCalling({ id: 'customer-1' }, (value) => {
					forwarded = value;
				}),
			],
			authorizeToolAccess,
			tools: [
				tool({
					execute: async () => ({
						notes: 'x'.repeat(MAX_TOOL_OUTPUT_CHARACTERS + 500),
					}),
				}),
			],
		});
		const result = await harness.execute(request());
		expect(typeof forwarded).toBe('string');
		expect((forwarded as string).length).toBeLessThan(
			MAX_TOOL_OUTPUT_CHARACTERS + 100,
		);
		expect(forwarded).toMatch(
			/\[tool output truncated: \d+ characters omitted\]$/,
		);
		expect(
			result.events.find((event) => event.type === 'tool.completed')?.metadata,
		).toMatchObject({ tool: TOOL_ID, truncated: true });
	});

	it('records a denial event for a tool the run was not granted', async () => {
		const harness = new AgentHarness({
			providers: [providerCalling({ id: 'customer-1' })],
			authorizeToolAccess,
			tools: [tool()],
		});
		const result = await harness.execute(request({ toolGrants: [] }));
		expect(result.output).toMatch(/not granted/);
		expect(
			result.events.find((event) => event.type === 'tool.denied')?.metadata,
		).toMatchObject({ tool: TOOL_ID, reason: 'TOOL_NOT_GRANTED' });
	});

	it('keeps event sequences monotonic across concurrent tool calls', async () => {
		const provider: AgentProvider = {
			id: 'tool-test',
			execute: async (context) => {
				await Promise.all(
					[1, 2, 3].map((index) =>
						context.invokeTool(TOOL_ID, { id: `customer-${index}` }),
					),
				);
				return {
					output: 'done',
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					finishReason: 'stop',
				};
			},
		};
		const harness = new AgentHarness({
			providers: [provider],
			authorizeToolAccess,
			tools: [
				tool({
					execute: async (input) => {
						await new Promise((resolve) =>
							setTimeout(resolve, Number(String(input).length % 3) * 5),
						);
						return input;
					},
				}),
			],
		});
		const result = await harness.execute(request());
		expect(result.events.map((event) => event.sequence)).toEqual(
			result.events.map((_, index) => index + 1),
		);
		expect(
			types(result.events).filter((type) => type === 'tool.completed'),
		).toHaveLength(3);
	});

	it('rejects a tool registered with an out-of-range timeout', () => {
		expect(
			() =>
				new AgentHarness({
					providers: [providerCalling({})],
					authorizeToolAccess,
					tools: [tool({ timeoutMs: 10 })],
				}),
		).toThrow(AgentHarnessError);
	});
});
