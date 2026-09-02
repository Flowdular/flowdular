import { describe, expect, it, vi } from 'vitest';
import {
	AgentHarness,
	AgentHarnessError,
	LocalSimulationProvider,
	type AgentExecutionEvent,
	type AgentExecutionRequest,
	type AgentProvider,
	type AgentTool,
	type AgentToolContext,
} from '../src/index.ts';
import { agentActor, serviceActor, userActor } from '@coreloom/kernel';

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
	it('rejects mismatched actor provenance before provider work', async () => {
		const execute = vi.fn<AgentProvider['execute']>();
		const harness = new AgentHarness({
			providers: [{ id: 'unused-provider', execute }],
		});

		await expect(
			harness.execute(
				request({
					requestedBy: 'another-account',
					definition: {
						...request().definition,
						provider: 'unused-provider',
					},
				}),
			),
		).rejects.toMatchObject({ code: 'INVALID_ACTOR' });
		expect(execute).not.toHaveBeenCalled();
	});

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

	it('settles promptly when an aborted provider ignores its signal', async () => {
		let providerContext: Parameters<AgentProvider['execute']>[0] | undefined;
		const observed: AgentExecutionEvent[] = [];
		const provider: AgentProvider = {
			id: 'non-cooperative',
			execute: (context) => {
				providerContext = context;
				return new Promise(() => {});
			},
		};
		const harness = new AgentHarness({ providers: [provider] });
		const controller = new AbortController();
		const pending = harness.execute(
			request({
				definition: {
					...request().definition,
					provider: 'non-cooperative',
					timeoutMs: 10_000,
				},
			}),
			{ signal: controller.signal, onEvent: (event) => observed.push(event) },
		);
		controller.abort('worker-shutdown');

		await expect(pending).rejects.toMatchObject({
			code: 'EXECUTION_ABORTED',
			message: 'worker-shutdown',
		});
		providerContext?.emit('provider.output.delta', 'late output');
		expect(observed.some((event) => event.message === 'late output')).toBe(
			false,
		);
	});

	it('exposes a tool only when definition, run grant, and RBAC scope agree', async () => {
		let receivedContext: AgentToolContext | undefined;
		const execute = vi.fn(
			async (_input: unknown, context: AgentToolContext) => {
				receivedContext = context;
				return { customer: 'Ada' };
			},
		);
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
		const harness = new AgentHarness({
			providers: [provider],
			tools: [tool],
			authorizeToolAccess: () => ['parties.records.read'],
		});
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
		expect(receivedContext).toMatchObject({
			agentId: 'agent-1',
			agentName: 'Customer helper',
			actor: {
				kind: 'agent',
				id: 'agent-1',
				label: 'Customer helper',
				runId: 'run-1',
			},
			authorizationSubject: {
				kind: 'user',
				id: 'account-a',
			},
		});
	});

	it('authorizes an agent-authored run through its delegated user', async () => {
		let receivedContext: AgentToolContext | undefined;
		const authorize = vi.fn(() => ['parties.records.read']);
		const tool: AgentTool = {
			id: 'parties.customer.read',
			transport: 'api',
			target: 'parties.records.get',
			description: 'Read one customer.',
			requiredPermissions: ['parties.records.read'],
			execute: async (_input, context) => {
				receivedContext = context;
				return { customer: 'Ada' };
			},
		};
		const provider: AgentProvider = {
			id: 'delegated-tool-test',
			execute: async (context) => {
				await context.invokeTool(tool.id, {});
				return {
					output: 'done',
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					finishReason: 'stop',
				};
			},
		};
		const subject = userActor({
			accountId: 'owner-a',
			displayName: 'Owner',
			email: 'owner@example.com',
		});
		const harness = new AgentHarness({
			providers: [provider],
			tools: [tool],
			authorizeToolAccess: authorize,
		});
		await harness.execute(
			request({
				requestedBy: 'workflow-author',
				requestedActor: agentActor({
					runId: 'parent-run',
					agentId: 'workflow-author',
					agentName: 'Workflow author',
				}),
				authorizationSubject: subject,
				definition: {
					...request().definition,
					provider: provider.id,
					allowedTools: [tool.id],
				},
				toolGrants: [tool.id],
			}),
		);
		expect(authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				tenantId: 'tenant-a',
				actor: expect.objectContaining({ kind: 'user', id: 'owner-a' }),
			}),
		);
		expect(receivedContext).toMatchObject({
			actor: { kind: 'agent', id: 'agent-1', runId: 'run-1' },
			authorizationSubject: { kind: 'user', id: 'owner-a' },
		});
	});

	it('returns schema-bound structured output from a capable provider', async () => {
		const provider: AgentProvider = {
			id: 'structured',
			capabilities: { structuredOutput: true },
			execute: async () => ({
				output: '{"decision":"approve"}',
				structuredOutput: { decision: 'approve' },
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				finishReason: 'stop',
			}),
		};
		const harness = new AgentHarness({ providers: [provider] });
		const result = await harness.execute(
			request({
				definition: { ...request().definition, provider: 'structured' },
				outputContract: {
					kind: 'json-schema',
					name: 'Decision',
					schema: {
						type: 'object',
						required: ['decision'],
						properties: {
							decision: { type: 'string', enum: ['approve', 'reject'] },
						},
						additionalProperties: false,
					},
				},
			}),
		);
		expect(result.structuredOutput).toEqual({ decision: 'approve' });
	});

	it('refuses structured output when the provider cannot guarantee it', async () => {
		let executed = false;
		const provider: AgentProvider = {
			id: 'text-only',
			execute: async () => {
				executed = true;
				return {
					output: 'done',
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					finishReason: 'stop',
				};
			},
		};
		const harness = new AgentHarness({ providers: [provider] });
		await expect(
			harness.execute(
				request({
					definition: { ...request().definition, provider: 'text-only' },
					outputContract: {
						kind: 'json-schema',
						name: 'Result',
						schema: { type: 'object' },
					},
				}),
			),
		).rejects.toMatchObject({ code: 'STRUCTURED_OUTPUT_UNSUPPORTED' });
		expect(executed).toBe(false);
	});

	it('refuses an output schema that is not durable JSON', async () => {
		let executed = false;
		const provider: AgentProvider = {
			id: 'structured',
			capabilities: { structuredOutput: true },
			execute: async () => {
				executed = true;
				return {
					output: '{}',
					structuredOutput: {},
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					finishReason: 'stop',
				};
			},
		};
		const harness = new AgentHarness({ providers: [provider] });

		await expect(
			harness.execute(
				request({
					definition: { ...request().definition, provider: 'structured' },
					outputContract: {
						kind: 'json-schema',
						name: 'Invalid',
						schema: { type: 'object', properties: undefined } as never,
					},
				}),
			),
		).rejects.toMatchObject({ code: 'INVALID_OUTPUT_CONTRACT' });
		expect(executed).toBe(false);
	});

	it('refuses provider output that violates the structured schema', async () => {
		const provider: AgentProvider = {
			id: 'structured',
			capabilities: { structuredOutput: true },
			execute: async () => ({
				output: '{}',
				structuredOutput: {},
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				finishReason: 'stop',
			}),
		};
		const harness = new AgentHarness({ providers: [provider] });
		await expect(
			harness.execute(
				request({
					definition: { ...request().definition, provider: 'structured' },
					outputContract: {
						kind: 'json-schema',
						name: 'Decision',
						schema: {
							type: 'object',
							required: ['decision'],
							properties: { decision: { type: 'string' } },
						},
					},
				}),
			),
		).rejects.toMatchObject({ code: 'STRUCTURED_OUTPUT_INVALID' });
	});

	it('refuses non-JSON tool input before executing the tool', async () => {
		const execute = vi.fn(async () => ({ customer: 'Ada' }));
		const tool: AgentTool = {
			id: 'parties.customer.read',
			transport: 'api',
			target: 'parties.records.get',
			description: 'Read one customer.',
			requiredPermissions: [],
			inputSchema: { type: 'object' },
			execute,
		};
		const provider: AgentProvider = {
			id: 'tool-test',
			execute: async (context) => {
				const cyclic: Record<string, unknown> = {};
				cyclic.self = cyclic;
				await context.invokeTool('parties.customer.read', cyclic);
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
						allowedTools: [tool.id],
					},
					toolGrants: [tool.id],
				}),
			),
		).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
		expect(execute).not.toHaveBeenCalled();
	});

	it('validates a tool result against its declared output schema', async () => {
		const tool: AgentTool = {
			id: 'parties.customer.read',
			transport: 'api',
			target: 'parties.records.get',
			description: 'Read one customer.',
			requiredPermissions: [],
			inputSchema: { type: 'object' },
			outputSchema: {
				type: 'object',
				required: ['customer'],
				properties: { customer: { type: 'string' } },
				additionalProperties: false,
			},
			execute: async () => ({ customer: 42 }),
		};
		const provider: AgentProvider = {
			id: 'tool-test',
			execute: async (context) => {
				await context.invokeTool(tool.id, {});
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
						allowedTools: [tool.id],
					},
					toolGrants: [tool.id],
				}),
			),
		).rejects.toMatchObject({ code: 'TOOL_OUTPUT_INVALID' });
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

	it('reauthorizes the initiating actor before every tool call', async () => {
		let livePermissions = ['parties.records.read'];
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
				livePermissions = [];
				await context.invokeTool(tool.id, {});
				throw new Error('unreachable');
			},
		};
		const harness = new AgentHarness({
			providers: [provider],
			tools: [tool],
			authorizeToolAccess: () => livePermissions,
		});

		await expect(
			harness.execute(
				request({
					definition: {
						...request().definition,
						provider: provider.id,
						allowedTools: [tool.id],
					},
					toolGrants: [tool.id],
				}),
			),
		).rejects.toMatchObject({ code: 'TOOL_AUTHORIZATION_REVOKED' });
		expect(execute).not.toHaveBeenCalled();
	});

	it('keeps a service actor tool-less without an explicit live policy', async () => {
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
				await context.invokeTool(tool.id, {});
				throw new Error('unreachable');
			},
		};
		const harness = new AgentHarness({ providers: [provider], tools: [tool] });
		await expect(
			harness.execute(
				request({
					requestedBy: 'schedule:daily',
					requestedActor: serviceActor({
						serviceId: 'schedule:daily',
						label: 'Daily schedule',
						configuredBy: userActor({
							accountId: 'account-a',
							displayName: 'Ada',
							email: 'ada@example.com',
						}),
					}),
					definition: {
						...request().definition,
						provider: provider.id,
						allowedTools: [tool.id],
					},
					toolGrants: [tool.id],
				}),
			),
		).rejects.toMatchObject({ code: 'TOOL_NOT_GRANTED' });
		expect(execute).not.toHaveBeenCalled();
	});

	it('fails closed when live authorization is unavailable', async () => {
		const provider: AgentProvider = {
			id: 'tool-test',
			execute: async () => {
				throw new Error('unreachable');
			},
		};
		const harness = new AgentHarness({
			providers: [provider],
			authorizeToolAccess: () => {
				throw new Error('auth database unavailable');
			},
		});

		await expect(
			harness.execute(
				request({
					definition: { ...request().definition, provider: provider.id },
				}),
			),
		).rejects.toMatchObject({ code: 'TOOL_AUTHORIZATION_FAILED' });
	});

	it('refuses a required-idempotency mutation without target deduplication', async () => {
		const execute = vi.fn(async () => ({ created: true }));
		const tool: AgentTool = {
			id: 'parties.customer.create',
			transport: 'api',
			target: 'parties.records.create',
			description: 'Create one customer.',
			requiredPermissions: ['parties.records.manage'],
			risk: 'workspace-write',
			idempotency: 'required',
			execute,
		};
		const provider: AgentProvider = {
			id: 'tool-test',
			execute: async (context) => {
				await context.invokeTool(tool.id, {}, { providerCallId: 'call-1' });
				throw new Error('unreachable');
			},
		};
		const harness = new AgentHarness({
			providers: [provider],
			tools: [tool],
			authorizeToolAccess: () => ['parties.records.manage'],
		});

		await expect(
			harness.execute(
				request({
					definition: {
						...request().definition,
						provider: provider.id,
						allowedTools: [tool.id],
					},
					permissionSnapshot: ['parties.records.manage'],
					toolGrants: [tool.id],
				}),
			),
		).rejects.toMatchObject({ code: 'TOOL_IDEMPOTENCY_UNAVAILABLE' });
		expect(execute).not.toHaveBeenCalled();
	});

	it('reuses deterministic tool call keys when a durable run is replayed', async () => {
		const keys: string[] = [];
		let attempt = 0;
		const tool: AgentTool = {
			id: 'parties.customer.read',
			transport: 'api',
			target: 'parties.records.get',
			description: 'Read one customer.',
			requiredPermissions: ['parties.records.read'],
			risk: 'read',
			idempotency: 'required',
			execute: async (_input, context) => {
				keys.push(context.idempotencyKey!);
				return { customer: 'Ada' };
			},
		};
		const provider: AgentProvider = {
			id: 'tool-test',
			execute: async (context) => {
				attempt += 1;
				await context.invokeTool(
					tool.id,
					{},
					{
						providerCallId: `provider-attempt-${attempt}`,
					},
				);
				return {
					output: 'done',
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					finishReason: 'stop',
				};
			},
		};
		const harness = new AgentHarness({
			providers: [provider],
			tools: [tool],
			authorizeToolAccess: () => ['parties.records.read'],
		});
		const replayed = request({
			definition: {
				...request().definition,
				provider: provider.id,
				allowedTools: [tool.id],
			},
			toolGrants: [tool.id],
		});

		await harness.execute(replayed);
		await harness.execute(replayed);

		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(keys[1]);
	});
});
