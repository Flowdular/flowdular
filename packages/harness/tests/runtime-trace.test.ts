import { describe, expect, it } from 'vitest';
import {
	AgentHarness,
	AgentHarnessError,
	type AgentExecutionRequest,
	type AgentProvider,
	type AgentProviderContext,
	type AgentSpanOptions,
	type AgentTraceContext,
	type AgentTraceSpan,
	type AgentTracer,
	type AgentTool,
} from '../src/runtime.ts';
import { userActor } from '@flowdular/kernel';

interface Recorded {
	readonly name: string;
	readonly parent: AgentTraceContext | null | undefined;
	readonly kind: string | undefined;
	readonly attributes: Readonly<Record<string, string | number | boolean>>;
	status?: 'unset' | 'ok' | 'error' | undefined;
	message?: string | undefined;
	readonly context: AgentTraceContext;
}

/** A tracer that keeps every span, so a case asserts what a collector sees. */
function recordingTracer(): { tracer: AgentTracer; spans: Recorded[] } {
	const spans: Recorded[] = [];
	let next = 0;
	const tracer: AgentTracer = {
		startSpan(name: string, options: AgentSpanOptions = {}): AgentTraceSpan {
			next += 1;
			const recorded: Recorded = {
				name,
				parent: options.parent,
				kind: options.kind,
				attributes: { ...options.attributes },
				context: {
					traceId: 'a'.repeat(32),
					spanId: String(next).padStart(16, '0'),
					sampled: true,
				},
			};
			spans.push(recorded);
			return {
				context: recorded.context,
				setAttribute: () => undefined,
				end: (status, message) => {
					recorded.status = status;
					recorded.message = message;
				},
			};
		},
	};
	return { tracer, spans };
}

const REQUEST: AgentExecutionRequest = {
	runId: 'run-1',
	tenantId: 'tenant-1',
	requestedBy: 'user-1',
	requestedActor: userActor({
		accountId: 'user-1',
		displayName: 'Ada',
		email: 'ada@example.com',
	}),
	trigger: 'playground',
	input: 'do the thing',
	definition: {
		id: 'agent-1',
		name: 'Assistant',
		revision: 1,
		instructions: 'Be useful.',
		provider: 'test-provider',
		model: 'test-model',
		allowedTools: ['records.read'],
		maxSteps: 4,
		timeoutMs: 5_000,
		temperature: 0,
	},
	permissionSnapshot: ['records.read'],
	toolGrants: ['records.read'],
};

const READ_TOOL: AgentTool = {
	id: 'records.read',
	transport: 'api',
	target: 'test.core',
	description: 'Reads a record.',
	requiredPermissions: ['records.read'],
	risk: 'read',
	execute: () => Promise.resolve({ ok: true }),
};

function providerCalling(
	body: (context: AgentProviderContext) => Promise<void>,
): AgentProvider {
	return {
		id: 'test-provider',
		async execute(context) {
			await body(context);
			return {
				output: 'done',
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				finishReason: 'stop',
			};
		},
	};
}

function harnessWith(
	provider: AgentProvider,
	tracer?: AgentTracer,
): AgentHarness {
	return new AgentHarness({
		providers: [provider],
		tools: [READ_TOOL],
		authorizeToolAccess: () => ['records.read'],
		...(tracer ? { tracer } : {}),
	});
}

describe('harness spans', () => {
	it('wraps the provider call with its identities', async () => {
		const { tracer, spans } = recordingTracer();
		const harness = harnessWith(
			providerCalling(() => Promise.resolve()),
			tracer,
		);

		await harness.execute(REQUEST);

		expect(spans).toHaveLength(1);
		expect(spans[0]).toMatchObject({
			name: 'provider test-provider',
			kind: 'client',
			status: 'ok',
			message: 'stop',
		});
		expect(spans[0]?.attributes).toEqual({
			'flowdular.agent.run_id': 'run-1',
			'flowdular.agent.id': 'agent-1',
			'flowdular.agent.provider': 'test-provider',
			'flowdular.agent.model': 'test-model',
			'flowdular.agent.trigger': 'playground',
		});
	});

	it('nests a tool call under the provider that invoked it', async () => {
		const { tracer, spans } = recordingTracer();
		const harness = harnessWith(
			providerCalling(async (context) => {
				await context.invokeTool('records.read', {}, { providerCallId: 'c-1' });
			}),
			tracer,
		);

		await harness.execute(REQUEST);
		const [provider, tool] = spans as [Recorded, Recorded];

		expect(tool).toMatchObject({
			name: 'tool records.read',
			kind: 'internal',
			status: 'ok',
		});
		expect(tool.parent).toEqual(provider.context);
		expect(tool.attributes).toMatchObject({
			'flowdular.tool': 'records.read',
			'flowdular.tool.provider_call_id': 'c-1',
		});
	});

	it('marks a denied tool with the refusal code', async () => {
		const { tracer, spans } = recordingTracer();
		const harness = harnessWith(
			providerCalling(async (context) => {
				await context.invokeTool('records.write', {}).catch(() => undefined);
			}),
			tracer,
		);

		await harness.execute(REQUEST);

		expect(spans[1]).toMatchObject({
			name: 'tool records.write',
			status: 'error',
			message: 'TOOL_NOT_GRANTED',
		});
	});

	it('marks a failing tool and still lets the run settle', async () => {
		const { tracer, spans } = recordingTracer();
		const failing: AgentTool = {
			...READ_TOOL,
			id: 'records.fail',
			execute: () => Promise.reject(new Error('tool defect')),
		};
		const harness = new AgentHarness({
			providers: [
				providerCalling(async (context) => {
					await context.invokeTool('records.fail', {}).catch(() => undefined);
				}),
			],
			tools: [failing],
			authorizeToolAccess: () => ['records.read'],
			tracer,
		});

		await harness.execute({
			...REQUEST,
			definition: { ...REQUEST.definition, allowedTools: ['records.fail'] },
			toolGrants: ['records.fail'],
		});

		expect(spans[1]).toMatchObject({
			name: 'tool records.fail',
			status: 'error',
			message: 'TOOL_EXECUTION_FAILED',
		});
	});

	it('marks the provider span when the run fails', async () => {
		const { tracer, spans } = recordingTracer();
		const harness = harnessWith(
			{
				id: 'test-provider',
				execute: () =>
					Promise.reject(
						new AgentHarnessError('PROVIDER_REFUSED', 'no capacity'),
					),
			},
			tracer,
		);

		await expect(harness.execute(REQUEST)).rejects.toThrow(/no capacity/);
		expect(spans[0]).toMatchObject({
			name: 'provider test-provider',
			status: 'error',
			message: 'PROVIDER_REFUSED',
		});
	});

	it('survives a tracer that throws on every call', async () => {
		const broken: AgentTracer = {
			startSpan: () => {
				throw new Error('tracer defect');
			},
		};
		const harness = harnessWith(
			providerCalling(async (context) => {
				await context.invokeTool('records.read', {});
			}),
			broken,
		);

		await expect(harness.execute(REQUEST)).resolves.toMatchObject({
			output: 'done',
		});
	});

	it('survives a span whose end throws', async () => {
		const broken: AgentTracer = {
			startSpan: () => ({
				context: {
					traceId: 'b'.repeat(32),
					spanId: 'c'.repeat(16),
					sampled: true,
				},
				setAttribute: () => undefined,
				end: () => {
					throw new Error('span defect');
				},
			}),
		};
		const harness = harnessWith(
			providerCalling(async (context) => {
				await context.invokeTool('records.read', {});
			}),
			broken,
		);

		await expect(harness.execute(REQUEST)).resolves.toMatchObject({
			output: 'done',
		});
	});

	it('records nothing and hands the provider the plain tool call without a tracer', async () => {
		let received: unknown;
		const harness = harnessWith(
			providerCalling(async (context) => {
				received = await context.invokeTool('records.read', {});
			}),
		);

		await expect(harness.execute(REQUEST)).resolves.toMatchObject({
			output: 'done',
		});
		expect(received).toEqual({ ok: true });
	});
});
