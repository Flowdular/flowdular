import { createPlatformToolRegistry, userActor } from '@coreloom/kernel';
import {
	AgentHarness,
	LocalSimulationProvider,
	type AgentExecutionEvent,
	type AgentExecutionRequest,
	type AgentProvider,
	type AgentTool,
} from '@coreloom/harness';
import {
	catalogAgentTools,
	createCatalogRuntime,
} from '@coreloom/module-catalog/server';
import {
	createPartiesRuntime,
	partiesAgentTools,
} from '@coreloom/module-parties/server';
import { describe, expect, it } from 'vitest';

const NO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as const;

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
		input: 'Register the new customer.',
		definition: {
			id: 'agent-1',
			name: 'Operations agent',
			revision: 1,
			instructions: 'Use the granted tools to maintain master data.',
			provider: 'caller',
			model: 'deterministic-v1',
			allowedTools: ['parties.customer.create'],
			maxSteps: 4,
			timeoutMs: 2_000,
			temperature: 0,
		},
		permissionSnapshot: ['parties.records.manage'],
		toolGrants: ['parties.customer.create'],
		...overrides,
	};
}

/* A provider that invokes the create tool once and reports whether the call
   was denied, so a run completes with its tool events either way. */
function caller(input: Record<string, unknown>): AgentProvider {
	return {
		id: 'caller',
		execute: async (context) => {
			try {
				const created = await context.invokeTool(
					'parties.customer.create',
					input,
				);
				return {
					output: JSON.stringify(created),
					usage: NO_USAGE,
					finishReason: 'stop',
				};
			} catch {
				return { output: 'denied', usage: NO_USAGE, finishReason: 'stop' };
			}
		},
	};
}

describe('platform agent tools through the harness', () => {
	it('surfaces every registered module tool id in harness.tools()', () => {
		const registry = createPlatformToolRegistry<AgentTool>();
		registry.register(
			partiesAgentTools(createPartiesRuntime({ databasePath: ':memory:' })),
		);
		registry.register(
			catalogAgentTools(createCatalogRuntime({ databasePath: ':memory:' })),
		);
		const harness = new AgentHarness({
			providers: [new LocalSimulationProvider()],
			tools: registry.list(),
		});
		expect(harness.tools()).toEqual([
			'catalog.item.create',
			'catalog.item.list',
			'parties.customer.create',
			'parties.customer.get',
			'parties.customer.list',
		]);
	});

	it('creates once and replays a mutating module tool without a duplicate', async () => {
		const runtime = createPartiesRuntime({ databasePath: ':memory:' });
		const provider = caller({ name: 'Acme', kind: 'customer' });
		const harness = new AgentHarness({
			providers: [provider],
			tools: partiesAgentTools(runtime),
			authorizeToolAccess: () => ['parties.records.manage'],
		});
		const events: AgentExecutionEvent[] = [];
		const result = await harness.execute(request(), {
			provider,
			onEvent: (event) => events.push(event),
		});
		const replay = await harness.execute(request(), { provider });

		expect(runtime.service().list('tenant-a')).toHaveLength(1);
		expect(runtime.service().list('tenant-b')).toHaveLength(0);
		expect(JSON.parse(result.output)).toMatchObject({
			name: 'Acme',
			kind: 'customer',
		});
		expect(replay.output).toBe(result.output);
		expect(events.some((event) => event.type === 'tool.completed')).toBe(true);
		expect(events.some((event) => event.type === 'tool.denied')).toBe(false);
	});

	it('denies the tool and writes nothing when the run lacks the manage scope', async () => {
		const runtime = createPartiesRuntime({ databasePath: ':memory:' });
		const provider = caller({ name: 'Acme', kind: 'customer' });
		const harness = new AgentHarness({
			providers: [provider],
			tools: partiesAgentTools(runtime),
			authorizeToolAccess: () => ['parties.records.read'],
		});
		const events: AgentExecutionEvent[] = [];
		const result = await harness.execute(
			request({ permissionSnapshot: ['parties.records.read'] }),
			{ provider, onEvent: (event) => events.push(event) },
		);

		expect(result.output).toBe('denied');
		expect(
			events.some(
				(event) =>
					event.type === 'tool.denied' &&
					event.metadata?.reason === 'TOOL_NOT_GRANTED',
			),
		).toBe(true);
		expect(events.some((event) => event.type === 'tool.started')).toBe(false);
		expect(runtime.service().list('tenant-a')).toHaveLength(0);
	});
});
