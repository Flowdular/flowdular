import { describe, expect, it } from 'vitest';
import {
	AgentHarness,
	createVercelAiSdkProvider,
	systemPreamble,
	type AgentExecutionRequest,
	type VercelAiProviderConfiguration,
} from '../src/index.ts';
import { userActor } from '@coreloom/kernel';

const INSTRUCTIONS =
	'Answer billing questions for the finance team and escalate disputes.';

function request(
	overrides: Partial<AgentExecutionRequest['definition']> = {},
): AgentExecutionRequest {
	return {
		runId: 'run-1',
		tenantId: 'tenant-finance',
		requestedBy: 'account-a',
		requestedActor: userActor({
			accountId: 'account-a',
			displayName: 'Ada',
			email: 'ada@example.com',
		}),
		trigger: 'playground',
		input: 'Why was invoice 42 charged twice?',
		definition: {
			id: 'agent-1',
			name: 'Billing helper',
			revision: 3,
			instructions: INSTRUCTIONS,
			provider: 'provider.openai',
			model: 'gpt-4o-mini',
			allowedTools: [],
			maxSteps: 2,
			timeoutMs: 5_000,
			temperature: 0.4,
			...overrides,
		},
		permissionSnapshot: [],
		toolGrants: [],
	};
}

/* The provider answers 400 so the adapter fails fast after one request; the
   captured body is what the adapter would send to a live model. */
async function requestBody(
	configuration: Omit<VercelAiProviderConfiguration, 'fetch'>,
	execution: AgentExecutionRequest,
): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> = {};
	const provider = createVercelAiSdkProvider({
		...configuration,
		fetch: async (_input, init) => {
			body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
			return new Response(JSON.stringify({ error: { message: 'stop' } }), {
				status: 400,
				headers: { 'content-type': 'application/json' },
			});
		},
	});
	const harness = new AgentHarness({ providers: [provider] });
	await expect(harness.execute(execution)).rejects.toMatchObject({
		code: 'PROVIDER_REQUEST_REJECTED',
	});
	return body;
}

/* The SDK carries `instructions` as the leading system item of `input`. */
function systemText(body: Record<string, unknown>): string {
	const items = Array.isArray(body.input) ? body.input : [];
	const system = items.find(
		(item) => (item as { role?: string }).role === 'system',
	) as { content?: unknown } | undefined;
	return typeof system?.content === 'string'
		? system.content
		: JSON.stringify(system?.content ?? '');
}

const openai = {
	id: 'provider.openai',
	kind: 'openai',
	model: 'gpt-4o-mini',
	credential: 'sk-test-credential',
} as const;

describe('Vercel AI SDK provider adapter', () => {
	it('prepends the platform preamble and keeps the instructions verbatim', async () => {
		const body = await requestBody(openai, request());
		const instructions = systemText(body);
		expect(instructions.endsWith(INSTRUCTIONS)).toBe(true);
		expect(instructions).toContain('tenant tenant-finance');
		expect(instructions).toContain('"Billing helper" (revision 3)');
		expect(instructions).toContain(
			`Current date: ${new Date().toISOString().slice(0, 10)}`,
		);
		expect(instructions).toContain('Granted tools: none');
		expect(instructions.indexOf('Refusal rules')).toBeLessThan(
			instructions.indexOf(INSTRUCTIONS),
		);
	});

	it('sends the agent temperature and output budget to a chat model', async () => {
		const body = await requestBody(openai, request({ maxOutputTokens: 1_024 }));
		expect(body.temperature).toBe(0.4);
		expect(body.max_output_tokens).toBe(1_024);
	});

	it('omits temperature for a reasoning model and defaults the output budget', async () => {
		const body = await requestBody(
			{ ...openai, model: 'gpt-5-mini' },
			request({ model: 'gpt-5-mini' }),
		);
		expect(body).not.toHaveProperty('temperature');
		expect(body.max_output_tokens).toBe(4_096);
	});

	it('lists granted tools in the preamble', () => {
		const preamble = systemPreamble(request(), ['parties.customer.read']);
		expect(preamble).toContain('Granted tools: parties.customer.read.');
		expect(preamble).not.toContain(INSTRUCTIONS);
	});
});
