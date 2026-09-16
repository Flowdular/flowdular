import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { userActor } from '@flowdular/kernel';
import {
	AgentHarness,
	type AgentExecutionRequest,
	type AgentProvider,
	type AgentProviderContext,
} from '@flowdular/harness';
import {
	RESEARCH_NATIVE_TOOL_ID,
	researchAgentTools,
	researchNativeTool,
} from '../src/agent/tools.ts';
import type { ResearchSettings } from '../src/domain/types.ts';
import { createResearchRuntime } from '../src/server/runtime.ts';
import {
	openResearchTestDatabase,
	type ResearchTestDatabase,
} from './support/database.ts';
import {
	testSettings,
	writeFixtures,
	type Fixtures,
} from './support/service.ts';

const TENANT = 'tenant-agents';
const PERMISSION = 'research.run';

let shared: ResearchTestDatabase;
let fixtures: Fixtures;
let settings: ResearchSettings;

beforeAll(async () => {
	shared = await openResearchTestDatabase();
	fixtures = await writeFixtures({
		queries: {
			'acme insurance': [
				{
					url: 'https://registry.example.org/acme',
					title: 'Acme',
					snippet: 'Registered.',
					source: 'registry.example.org',
				},
			],
		},
		pages: {},
	});
});

afterEach(async () => {
	await shared.reset();
});

afterAll(async () => {
	await fixtures?.dispose();
	await shared?.dispose();
});

function runtime() {
	return createResearchRuntime({
		databases: shared.databases,
		purpose: 'test',
		workspaceRoot: fixtures.directory,
		settings: async () => settings,
		repository: shared.repository,
	});
}

function request(tools: readonly string[]): AgentExecutionRequest {
	return {
		runId: 'run-research',
		tenantId: TENANT,
		requestedBy: 'account-ada',
		requestedActor: userActor({
			accountId: 'account-ada',
			displayName: 'Ada',
			email: 'ada@example.com',
		}),
		trigger: 'playground',
		input: 'acme insurance',
		definition: {
			id: 'agent-research',
			name: 'Researcher',
			revision: 1,
			instructions: 'Research the company and cite evidence.',
			provider: 'scripted',
			model: 'deterministic-v1',
			allowedTools: [...tools],
			maxSteps: 4,
			timeoutMs: 5_000,
			temperature: 0,
		},
		permissionSnapshot: [PERMISSION],
		toolGrants: [...tools],
	};
}

function scripted(
	script: (context: AgentProviderContext) => Promise<void>,
): AgentProvider {
	return {
		id: 'scripted',
		execute: async (context) => {
			await script(context);
			return {
				output: 'done',
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				finishReason: 'stop',
			};
		},
	};
}

describe('research agent tools', () => {
	it('RESEARCH-AGENT-CONSENT denies the tools until allowAgents is on, then keeps evidence of the run', async () => {
		const research = runtime();
		const harness = new AgentHarness({
			providers: [],
			tools: researchAgentTools(research),
			authorizeToolAccess: () => [PERMISSION],
		});
		const outcomes: unknown[] = [];
		const provider = scripted(async (context) => {
			try {
				outcomes.push(
					await context.invokeTool('research.search', {
						query: 'acme insurance',
					}),
				);
			} catch (error) {
				outcomes.push((error as { code: string }).code);
			}
		});

		settings = testSettings({ recordedFixturesPath: fixtures.path });
		const denied = await harness.execute(request(['research.search']), {
			provider,
		});
		expect(outcomes).toEqual(['TOOL_NOT_CONSENTED']);
		expect(
			denied.events.find((event) => event.type === 'tool.denied')?.metadata,
		).toEqual({
			tool: 'research.search',
			consent: 'research.consent',
			reason: 'TOOL_NOT_CONSENTED',
		});
		expect(await shared.repository.listQueries(TENANT, 10, null)).toEqual([]);

		settings = testSettings({
			recordedFixturesPath: fixtures.path,
			allowAgents: true,
		});
		await harness.execute(request(['research.search']), { provider });
		expect(outcomes[1]).toMatchObject({
			adapter: 'recorded',
			results: [
				{
					url: 'https://registry.example.org/acme',
					evidenceId: expect.any(String),
				},
			],
		});
		const [evidence] = await shared.repository.listEvidence(TENANT, 10, null);
		expect(evidence).toMatchObject({
			runId: 'run-research',
			createdBy: 'account-ada',
		});
		const [query] = await shared.repository.listQueries(TENANT, 10, null);
		expect(query).toMatchObject({ caller: 'agent', callerRef: 'run-research' });
		await research.dispose();
	});

	it('RESEARCH-MODEL-NATIVE records the citations a provider reports and lets the run cite them', async () => {
		const research = runtime();
		const harness = new AgentHarness({
			providers: [],
			tools: researchAgentTools(research),
			nativeTools: [researchNativeTool(research)],
			authorizeToolAccess: () => [PERMISSION],
		});
		const offered: AgentProviderContext['nativeTools'][] = [];
		const cited: unknown[] = [];
		const provider = scripted(async (context) => {
			offered.push(context.nativeTools);
			if (context.nativeTools.length === 0) return;
			await context.reportNative({
				id: RESEARCH_NATIVE_TOOL_ID,
				query: 'acme insurance',
				results: [
					{
						url: 'https://registry.example.org/acme',
						title: 'Acme',
						snippet: 'Registered.',
						source: 'registry.example.org',
					},
					{
						url: 'https://denied.example/acme',
						title: 'Denied',
						snippet: '',
						source: 'denied.example',
					},
				],
			});
			cited.push(
				await context.invokeTool('research.search', {
					query: 'acme insurance',
				}),
			);
		});
		const tools = [RESEARCH_NATIVE_TOOL_ID, 'research.search'];

		settings = testSettings({ adapter: 'recorded', allowAgents: true });
		await harness.execute(request(tools), { provider });
		expect(offered[0]).toEqual([]);

		settings = testSettings({
			adapter: 'model-native',
			allowAgents: true,
			denyDomains: ['denied.example'],
		});
		const run = await harness.execute(request(tools), { provider });
		expect(offered[1]).toEqual([
			{
				id: RESEARCH_NATIVE_TOOL_ID,
				kind: 'web-search',
				config: {
					maxResults: 20,
					allowedDomains: [],
					blockedDomains: ['denied.example'],
				},
			},
		]);
		expect(
			run.events.find((event) => event.type === 'tool.native')?.metadata,
		).toEqual({ tool: RESEARCH_NATIVE_TOOL_ID, results: 2 });
		const evidence = await shared.repository.listEvidence(TENANT, 10, null);
		expect(evidence.map((entry) => [entry.url, entry.runId])).toEqual([
			['https://registry.example.org/acme', 'run-research'],
		]);
		expect(cited).toEqual([
			{
				adapter: 'model-native',
				results: [expect.objectContaining({ evidenceId: evidence[0]!.id })],
			},
		]);

		settings = testSettings({
			adapter: 'model-native',
			allowAgents: true,
			monthlyQueryBudget: 1,
		});
		const spent = await harness.execute(request(tools), { provider });
		expect(offered[2]).toEqual([]);
		expect(
			spent.events.find((event) => event.type === 'tool.denied')?.metadata,
		).toEqual({
			tool: RESEARCH_NATIVE_TOOL_ID,
			consent: 'research.consent',
			reason: 'RESEARCH_BUDGET_EXCEEDED',
		});
		await research.dispose();
	});

	it('RESEARCH-RUN-LIMIT and the tool cut a page to the run window', async () => {
		const page = 'Long text. '.repeat(3_000);
		const pages = await writeFixtures({
			queries: {},
			pages: { 'https://a.example.org/long': { title: 'Long', text: page } },
		});
		try {
			settings = testSettings({
				recordedFixturesPath: pages.path,
				allowAgents: true,
			});
			const research = runtime();
			const harness = new AgentHarness({
				providers: [],
				tools: researchAgentTools(research),
				authorizeToolAccess: () => [PERMISSION],
			});
			const answers: unknown[] = [];
			await harness.execute(request(['research.fetch']), {
				provider: scripted(async (context) => {
					answers.push(
						await context.invokeTool('research.fetch', {
							url: 'https://a.example.org/long',
						}),
					);
				}),
			});
			expect(answers[0]).toMatchObject({ title: 'Long', truncated: true });
			expect((answers[0] as { text: string }).text.length).toBe(16_000);
			await research.dispose();
		} finally {
			await pages.dispose();
		}
	});
});
