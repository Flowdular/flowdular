import { describe, expect, it, vi } from 'vitest';
import { userActor } from '@flowdular/kernel';
import {
	AgentHarness,
	type AgentExecutionRequest,
	type AgentProvider,
} from '../src/runtime.ts';

const providerId = 'provider.01234567123441238123123456789abc';
function request(provider = providerId): AgentExecutionRequest {
	return {
		runId: 'run-test',
		tenantId: 'tenant-test',
		requestedBy: 'owner-test',
		requestedActor: userActor({
			accountId: 'owner-test',
			email: 'test@example.com',
		}),
		trigger: 'playground',
		input: 'Test input',
		permissionSnapshot: [],
		toolGrants: [],
		definition: {
			id: 'agent-test',
			name: 'Test agent',
			revision: 1,
			instructions: 'Return the test answer.',
			provider,
			model: 'test-model',
			allowedTools: [],
			maxSteps: 2,
			timeoutMs: 1000,
			temperature: 0,
		},
	};
}
function provider(id = providerId): AgentProvider {
	return {
		id,
		execute: vi.fn(async () => ({
			output: 'Test answer',
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			finishReason: 'stop' as const,
		})),
	};
}
describe('stored provider references', () => {
	it('executes a tenant-resolved provider whose generated suffix starts with a digit', async () => {
		const selected = provider();
		const harness = new AgentHarness({ providers: [] });
		expect(
			(await harness.execute(request(), { provider: selected })).output,
		).toBe('Test answer');
		expect(selected.execute).toHaveBeenCalledOnce();
	});
	it('can register the same provider ID directly', async () => {
		const harness = new AgentHarness({ providers: [provider()] });
		expect(harness.providers()).toEqual([providerId]);
		expect((await harness.execute(request())).output).toBe('Test answer');
	});
	it('still refuses mismatched, missing, empty, oversized and NUL references before execution', async () => {
		const selected = provider('provider.different');
		const harness = new AgentHarness({ providers: [] });
		await expect(
			harness.execute(request(), { provider: selected }),
		).rejects.toMatchObject({ code: 'PROVIDER_MISMATCH' });
		await expect(harness.execute(request())).rejects.toMatchObject({
			code: 'PROVIDER_NOT_AVAILABLE',
		});
		for (const id of ['', 'x'.repeat(129), 'provider.\u0000bad']) {
			await expect(
				harness.execute(request(id), { provider: selected }),
			).rejects.toMatchObject({ code: 'INVALID_INPUT' });
			expect(() => new AgentHarness({ providers: [provider(id)] })).toThrow();
		}
		expect(selected.execute).not.toHaveBeenCalled();
	});
});
