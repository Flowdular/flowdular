import { defineApiAgentTool } from '@flowdular/harness/tool-adapters';
import type {
	AgentNativeTool,
	AgentTool,
	AgentToolConsent,
	AgentToolContext,
} from '@flowdular/harness/runtime';
import { RESEARCH_PERMISSIONS } from '../acl/permissions.ts';
import type { ResearchFreshness } from '../domain/capability.ts';
import { RESEARCH_FRESHNESS, RESEARCH_LIMITS } from '../domain/types.ts';
import type { ResearchRuntime } from '../server/runtime.ts';

export const RESEARCH_CONSENT_ID = 'research.consent';
export const RESEARCH_NATIVE_TOOL_ID = 'research.web-search';

/* There is no server route behind either target: the harness runs the tool in
   this process, and the member routes answer under the session instead. */
export const RESEARCH_SEARCH_TOOL_TARGET = 'research.search.agent';
export const RESEARCH_FETCH_TOOL_TARGET = 'research.fetch.agent';

function callerOf(context: AgentToolContext): 'agent' | 'workflow' {
	return context.invocation === 'workflow-action' ? 'workflow' : 'agent';
}

function consentGate(runtime: ResearchRuntime): AgentToolConsent {
	return {
		id: RESEARCH_CONSENT_ID,
		async check(_input, context) {
			return (await (await runtime.service()).agentsAllowed(context.tenantId))
				? { granted: true }
				: { granted: false, reason: 'TOOL_NOT_CONSENTED' };
		},
	};
}

export function researchAgentTools(
	runtime: ResearchRuntime,
): readonly AgentTool[] {
	const consent = consentGate(runtime);
	return [
		defineApiAgentTool({
			id: 'research.search',
			endpointId: RESEARCH_SEARCH_TOOL_TARGET,
			description:
				'Search the web through the adapter this workspace selected and answer the kept results with their evidence ids. Cite a finding by its evidence id.',
			requiredPermissions: [RESEARCH_PERMISSIONS.run],
			risk: 'workspace-write',
			cancellation: 'cooperative',
			consent,
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['query'],
				properties: {
					query: {
						type: 'string',
						minLength: 1,
						maxLength: RESEARCH_LIMITS.query,
					},
					limit: {
						type: 'integer',
						minimum: 1,
						maximum: RESEARCH_LIMITS.searchMax,
					},
					freshness: { type: 'string', enum: [...RESEARCH_FRESHNESS] },
					site: { type: 'string', maxLength: RESEARCH_LIMITS.site },
				},
			},
			execute: async (input, context) => {
				const value = (input ?? {}) as Record<string, unknown>;
				const answer = await (
					await runtime.service()
				).search(
					{
						/* Tenant and run come from the run, never from the input. */
						tenantId: context.tenantId,
						query: String(value.query ?? ''),
						...(value.limit === undefined
							? {}
							: { limit: value.limit as number }),
						...(value.freshness === undefined
							? {}
							: { freshness: value.freshness as ResearchFreshness }),
						...(value.site === undefined ? {} : { site: String(value.site) }),
						caller: callerOf(context),
						callerRef: context.runId,
						signal: context.signal,
					},
					context.requestedBy,
				);
				return { adapter: answer.adapter, results: answer.results };
			},
		}),
		defineApiAgentTool({
			id: 'research.fetch',
			endpointId: RESEARCH_FETCH_TOOL_TARGET,
			description:
				'Read one public https page as text under the workspace domain rules and robots.txt, and answer its evidence id and sha256.',
			requiredPermissions: [RESEARCH_PERMISSIONS.run],
			risk: 'workspace-write',
			cancellation: 'cooperative',
			consent,
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['url'],
				properties: {
					url: { type: 'string', minLength: 1, maxLength: RESEARCH_LIMITS.url },
				},
			},
			execute: async (input, context) => {
				const value = (input ?? {}) as Record<string, unknown>;
				const page = await (
					await runtime.service()
				).fetch(
					{
						tenantId: context.tenantId,
						url: String(value.url ?? ''),
						caller: callerOf(context),
						callerRef: context.runId,
						signal: context.signal,
					},
					context.requestedBy,
				);
				/* One run window holds a bounded page; the evidence keeps the digest
				   of all of it. */
				return {
					evidenceId: page.evidenceId,
					title: page.title,
					text: page.text.slice(0, RESEARCH_LIMITS.toolFetchText),
					truncated:
						page.truncated || page.text.length > RESEARCH_LIMITS.toolFetchText,
					contentSha256: page.contentSha256,
					retrievedAt: page.retrievedAt,
				};
			},
		}),
	];
}

/**
 * The provider-executed web search of the model-native adapter. It is offered
 * only while agents are allowed, the adapter is model-native and the budget
 * has room; its citations become the run's query and evidence.
 */
export function researchNativeTool(runtime: ResearchRuntime): AgentNativeTool {
	return {
		id: RESEARCH_NATIVE_TOOL_ID,
		kind: 'web-search',
		config: { maxResults: RESEARCH_LIMITS.searchMax },
		requiredPermissions: [RESEARCH_PERMISSIONS.run],
		consent: {
			id: RESEARCH_CONSENT_ID,
			check: async (_input, context) =>
				(await runtime.service()).nativeAdmission(context.tenantId),
		},
		resolveConfig: async (context) => {
			const settings = await (
				await runtime.service()
			).settings(context.tenantId);
			return {
				allowedDomains: [...settings.allowDomains],
				blockedDomains: [...settings.denyDomains],
			};
		},
		record: async (report, context) =>
			(await runtime.service()).recordNative(
				context.tenantId,
				context.runId,
				context.requestedBy,
				report.query,
				report.results,
			),
	};
}
