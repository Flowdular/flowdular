import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { userActor } from '@flowdular/kernel';
import {
	AgentHarness,
	LocalSimulationProvider,
	NATIVE_TOOL_UNSUPPORTED,
	type AgentExecutionRequest,
	type AgentNativeResult,
	type AgentNativeTool,
	type AgentProvider,
	type AgentProviderContext,
	type AgentToolContext,
} from '../src/index.ts';

const PERMISSION = 'research.run';
const NATIVE_ID = 'research.web-search';

function request(
	overrides: Partial<AgentExecutionRequest> = {},
): AgentExecutionRequest {
	return {
		runId: 'run-native',
		tenantId: 'tenant-a',
		requestedBy: 'account-a',
		requestedActor: userActor({
			accountId: 'account-a',
			displayName: 'Ada',
			email: 'ada@example.com',
		}),
		trigger: 'playground',
		input: 'acme insurance',
		definition: {
			id: 'agent-1',
			name: 'Researcher',
			revision: 1,
			instructions: 'Search the web and cite what you found.',
			provider: 'native-provider',
			model: 'deterministic-v1',
			allowedTools: [NATIVE_ID],
			maxSteps: 4,
			timeoutMs: 2_000,
			temperature: 0,
		},
		permissionSnapshot: [PERMISSION],
		toolGrants: [NATIVE_ID],
		...overrides,
	};
}

interface Recorded {
	readonly query: string | null;
	readonly results: readonly AgentNativeResult[];
	readonly unsupported?: {
		readonly code: string;
		readonly detail: string | null;
	};
	readonly context: AgentToolContext;
}

function nativeTool(
	recorded: Recorded[],
	overrides: Partial<AgentNativeTool> = {},
): AgentNativeTool {
	return {
		id: NATIVE_ID,
		kind: 'web-search',
		config: { maxUses: 4 },
		requiredPermissions: [PERMISSION],
		record: async (report, context) => {
			recorded.push({ ...report, context });
		},
		...overrides,
	};
}

/** A provider that reports what a native search would have answered. */
function reporting(
	report: (context: AgentProviderContext) => Promise<void>,
	seen: AgentProviderContext[] = [],
): AgentProvider {
	return {
		id: 'native-provider',
		execute: async (context) => {
			seen.push(context);
			await report(context);
			return {
				output: 'done',
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				finishReason: 'stop',
			};
		},
	};
}

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe('native tools', () => {
	it('lists a native tool with the other ids and grants it by the same rule', () => {
		const harness = new AgentHarness({
			providers: [reporting(async () => undefined)],
			nativeTools: [nativeTool([])],
		});
		expect(harness.tools()).toEqual([NATIVE_ID]);
		expect(harness.nativeTools()).toEqual([NATIVE_ID]);
		expect(
			harness.effectiveToolGrants([NATIVE_ID], [NATIVE_ID], [PERMISSION]),
		).toEqual([NATIVE_ID]);
		expect(harness.effectiveToolGrants([NATIVE_ID], [NATIVE_ID], [])).toEqual(
			[],
		);
	});

	it('refuses a native tool whose id another tool already holds', () => {
		expect(
			() =>
				new AgentHarness({
					providers: [],
					tools: [
						{
							id: NATIVE_ID,
							transport: 'api',
							target: 'research.search',
							description: 'x',
							requiredPermissions: [],
							execute: async () => null,
						},
					],
					nativeTools: [nativeTool([])],
				}),
		).toThrow(/already registered/);
	});

	it('offers the granted tool with its resolved config and records the bounded citations', async () => {
		const recorded: Recorded[] = [];
		const seen: AgentProviderContext[] = [];
		const harness = new AgentHarness({
			providers: [],
			nativeTools: [
				nativeTool(recorded, {
					resolveConfig: (context) => ({
						blockedDomains: ['denied.example'],
						tenant: context.tenantId,
					}),
				}),
			],
			authorizeToolAccess: () => [PERMISSION],
		});
		const result = await harness.execute(request(), {
			provider: reporting(async (context) => {
				await context.reportNative({
					id: NATIVE_ID,
					query: 'acme insurance',
					results: [
						{
							url: 'https://acme.example/about',
							title: 'A'.repeat(400),
							snippet: 'Acme writes policies.',
							source: 'acme.example',
						},
						{
							url: 'javascript:alert(1)',
							title: 'bad',
							snippet: '',
							source: 'x',
						},
					],
				});
			}, seen),
		});
		expect(seen[0]!.nativeTools).toEqual([
			{
				id: NATIVE_ID,
				kind: 'web-search',
				config: {
					maxUses: 4,
					blockedDomains: ['denied.example'],
					tenant: 'tenant-a',
				},
			},
		]);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]!.query).toBe('acme insurance');
		expect(recorded[0]!.results).toEqual([
			{
				url: 'https://acme.example/about',
				title: 'A'.repeat(300),
				snippet: 'Acme writes policies.',
				source: 'acme.example',
			},
		]);
		expect(recorded[0]!.context.runId).toBe('run-native');
		expect(recorded[0]!.context.tenantId).toBe('tenant-a');
		const native = result.events.find((event) => event.type === 'tool.native');
		expect(native?.metadata).toEqual({
			tool: NATIVE_ID,
			results: 1,
			dropped: 1,
		});
	});

	it('withholds the tool when its consent gate refuses and records the denial', async () => {
		const seen: AgentProviderContext[] = [];
		const harness = new AgentHarness({
			providers: [],
			nativeTools: [
				nativeTool([], {
					consent: {
						id: 'research.consent',
						check: () => ({ granted: false, reason: 'TOOL_NOT_CONSENTED' }),
					},
				}),
			],
			authorizeToolAccess: () => [PERMISSION],
		});
		const result = await harness.execute(request(), {
			provider: reporting(async () => undefined, seen),
		});
		expect(seen[0]!.nativeTools).toEqual([]);
		expect(
			result.events.find((event) => event.type === 'tool.denied')?.metadata,
		).toEqual({
			tool: NATIVE_ID,
			consent: 'research.consent',
			reason: 'TOOL_NOT_CONSENTED',
		});
	});

	it('withholds the tool from a run without the grant or the permission', async () => {
		const seen: AgentProviderContext[] = [];
		const harness = new AgentHarness({
			providers: [],
			nativeTools: [nativeTool([])],
			authorizeToolAccess: () => [],
		});
		await harness.execute(request(), {
			provider: reporting(async () => undefined, seen),
		});
		await harness.execute(request({ toolGrants: [] }), {
			provider: reporting(async () => undefined, seen),
		});
		expect(seen.map((context) => context.nativeTools)).toEqual([[], []]);
	});

	it('denies a report for a tool the run was not offered', async () => {
		const failures: string[] = [];
		const harness = new AgentHarness({
			providers: [],
			nativeTools: [nativeTool([])],
			authorizeToolAccess: () => [PERMISSION],
		});
		const result = await harness.execute(request({ toolGrants: [] }), {
			provider: reporting(async (context) => {
				try {
					await context.reportNative({ id: NATIVE_ID, results: [] });
				} catch (error) {
					failures.push((error as { code: string }).code);
				}
			}),
		});
		expect(failures).toEqual(['TOOL_NOT_GRANTED']);
		expect(
			result.events.find((event) => event.type === 'tool.denied')?.metadata,
		).toEqual({ tool: NATIVE_ID, reason: 'TOOL_NOT_GRANTED' });
	});

	it('refuses native reports past the per-run limit and after the run settled', async () => {
		const recorded: Recorded[] = [];
		let late: AgentProviderContext | undefined;
		const codes: string[] = [];
		const harness = new AgentHarness({
			providers: [],
			nativeTools: [nativeTool(recorded)],
			authorizeToolAccess: () => [PERMISSION],
		});
		const result = await harness.execute(request(), {
			provider: reporting(async (context) => {
				late = context;
				for (let index = 0; index < 17; index += 1) {
					try {
						await context.reportNative({ id: NATIVE_ID, results: [] });
					} catch (error) {
						codes.push((error as { code: string }).code);
					}
				}
			}),
		});
		expect(recorded).toHaveLength(16);
		expect(codes).toEqual(['NATIVE_REPORT_LIMIT']);
		expect(
			result.events
				.filter((event) => event.type === 'tool.denied')
				.map((event) => event.metadata),
		).toEqual([{ tool: NATIVE_ID, reason: 'NATIVE_REPORT_LIMIT' }]);
		await expect(
			late!.reportNative({ id: NATIVE_ID, results: [] }),
		).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' });
		expect(recorded).toHaveLength(16);
	});

	it('keeps the run when the record sink throws and says a provider could not pass the tool on', async () => {
		const harness = new AgentHarness({
			providers: [],
			nativeTools: [
				nativeTool([], {
					record: async () => {
						throw new Error('database down');
					},
				}),
			],
			authorizeToolAccess: () => [PERMISSION],
		});
		const result = await harness.execute(request(), {
			provider: reporting(async (context) => {
				await context.reportNative({ id: NATIVE_ID, results: [] });
				await context.reportNative({
					id: NATIVE_ID,
					code: NATIVE_TOOL_UNSUPPORTED,
				});
			}),
		});
		expect(result.output).toBe('done');
		expect(
			result.events
				.filter((event) => ['tool.native', 'tool.failed'].includes(event.type))
				.map((event) => [event.type, event.metadata]),
		).toEqual([
			['tool.native', { tool: NATIVE_ID, results: 0 }],
			['tool.failed', { tool: NATIVE_ID, reason: 'TOOL_EXECUTION_FAILED' }],
			['tool.native', { tool: NATIVE_ID, reason: NATIVE_TOOL_UNSUPPORTED }],
			['tool.failed', { tool: NATIVE_ID, reason: 'TOOL_EXECUTION_FAILED' }],
		]);
	});

	it('hands an unsupported report with its detail to the record hook, the path results take', async () => {
		const recorded: Recorded[] = [];
		let permissions = [PERMISSION];
		const harness = new AgentHarness({
			providers: [],
			nativeTools: [nativeTool(recorded)],
			authorizeToolAccess: () => permissions,
		});
		const result = await harness.execute(request(), {
			provider: reporting(async (context) => {
				await context.reportNative({
					id: NATIVE_ID,
					code: NATIVE_TOOL_UNSUPPORTED,
					detail: 'PROVIDER_WEB_SEARCH_DISABLED',
				});
				await context.reportNative({
					id: NATIVE_ID,
					code: NATIVE_TOOL_UNSUPPORTED,
					detail: 'not a code',
				});
			}),
		});

		expect(result.output).toBe('done');
		expect(
			recorded.map(({ query, results, unsupported, context }) => [
				query,
				results,
				unsupported,
				context.runId,
				context.tenantId,
			]),
		).toEqual([
			[
				null,
				[],
				{
					code: NATIVE_TOOL_UNSUPPORTED,
					detail: 'PROVIDER_WEB_SEARCH_DISABLED',
				},
				'run-native',
				'tenant-a',
			],
			[
				null,
				[],
				{ code: NATIVE_TOOL_UNSUPPORTED, detail: null },
				'run-native',
				'tenant-a',
			],
		]);
		expect(
			result.events
				.filter((event) => event.type === 'tool.native')
				.map((event) => event.metadata),
		).toEqual([
			{
				tool: NATIVE_ID,
				reason: NATIVE_TOOL_UNSUPPORTED,
				detail: 'PROVIDER_WEB_SEARCH_DISABLED',
			},
			{ tool: NATIVE_ID, reason: NATIVE_TOOL_UNSUPPORTED },
		]);

		/* A revoked permission withholds the record and never fails the run. */
		const withheld: Recorded[] = [];
		const revoking = new AgentHarness({
			providers: [],
			nativeTools: [nativeTool(withheld)],
			authorizeToolAccess: () => permissions,
		});
		const revoked = await revoking.execute(request(), {
			provider: reporting(async (context) => {
				permissions = [];
				await context.reportNative({
					id: NATIVE_ID,
					code: NATIVE_TOOL_UNSUPPORTED,
				});
			}),
		});
		expect(revoked.output).toBe('done');
		expect(withheld).toEqual([]);
		expect(
			revoked.events.find((event) => event.type === 'tool.denied')?.metadata,
		).toEqual({ tool: NATIVE_ID, reason: 'TOOL_AUTHORIZATION_REVOKED' });
	});

	it('answers a native web search from the fixtures file the request names in the local simulation', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'native-fixtures-'));
		directories.push(directory);
		const path = join(directory, 'research-fixtures.json');
		await writeFile(
			path,
			JSON.stringify({
				queries: {
					'acme insurance': [
						{
							url: 'https://registry.example/acme',
							title: 'Acme in the registry',
							snippet: 'Registered 1999.',
							source: 'registry.example',
						},
					],
				},
				pages: {},
			}),
		);
		const recorded: Recorded[] = [];
		const harness = new AgentHarness({
			providers: [new LocalSimulationProvider()],
			nativeTools: [nativeTool(recorded)],
			authorizeToolAccess: () => [PERMISSION],
		});
		const definition = {
			...request().definition,
			provider: 'local-simulation',
		};
		const answered = await harness.execute(
			request({ definition, nativeFixturesPath: path }),
		);
		expect(recorded.map((entry) => entry.results)).toEqual([
			[
				{
					url: 'https://registry.example/acme',
					title: 'Acme in the registry',
					snippet: 'Registered 1999.',
					source: 'registry.example',
				},
			],
		]);
		expect(answered.output).toContain(`Native tool ${NATIVE_ID}: 1 results.`);

		const offline = await harness.execute(request({ definition }));
		expect(
			offline.events.find((event) => event.type === 'tool.native')?.metadata,
		).toEqual({ tool: NATIVE_ID, reason: NATIVE_TOOL_UNSUPPORTED });
	});

	it('refuses a fixtures path that is relative or names another file', async () => {
		const harness = new AgentHarness({
			providers: [new LocalSimulationProvider()],
		});
		const definition = {
			...request().definition,
			provider: 'local-simulation',
		};
		for (const nativeFixturesPath of [
			'research-fixtures.json',
			'/etc/passwd',
		]) {
			await expect(
				harness.execute(request({ definition, nativeFixturesPath })),
			).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		}
	});
});
