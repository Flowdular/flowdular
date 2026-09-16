import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import { researchAgentTools, researchNativeTool } from './agent/tools.ts';
import {
	RESEARCH_EVIDENCE_CAPABILITY,
	RESEARCH_FETCH_CAPABILITY,
	RESEARCH_SEARCH_CAPABILITY,
	type ResearchEvidence,
	type ResearchFetch,
	type ResearchSearch,
} from './domain/capability.ts';
import { RESEARCH_MODULE_ID } from './domain/types.ts';
import { createResearchRoutes, createResearchRuntime } from './server/index.ts';
import {
	CONNECTORS_CALLS_CAPABILITY,
	CONNECTORS_EGRESS_CAPABILITY,
	EXPORT_LISTS_CAPABILITY,
	METERING_METERS_CAPABILITY,
	type ConnectorCalls,
	type ConnectorEgress,
	type ExportListRegistry,
	type MeterRegistry,
} from './services/capabilities.ts';
import { researchDataClasses } from './services/data-classes.ts';
import { researchListExports } from './services/list-exports.ts';
import { readResearchSettings, RESEARCH_MODULE_SETTINGS } from './settings.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const capabilities = context.capabilities;
	const meters = () =>
		capabilities.get<MeterRegistry>(METERING_METERS_CAPABILITY) ?? undefined;
	const runtime = createResearchRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		workspaceRoot: context.workspaceRoot,
		settings: (tenantId) => readResearchSettings(context.settings, tenantId),
		calls: () =>
			capabilities.get<ConnectorCalls>(CONNECTORS_CALLS_CAPABILITY) ??
			undefined,
		egress: () =>
			capabilities.get<ConnectorEgress>(CONNECTORS_EGRESS_CAPABILITY) ??
			undefined,
		meters,
	});
	const service = () => runtime.service();

	capabilities.register<ResearchSearch>(RESEARCH_SEARCH_CAPABILITY, {
		search: async (input) => {
			const answer = await (await service()).search(input);
			return { results: answer.results, adapter: answer.adapter };
		},
	});
	capabilities.register<ResearchFetch>(RESEARCH_FETCH_CAPABILITY, {
		fetch: async (input) => (await service()).fetch(input),
	});
	capabilities.register<ResearchEvidence>(RESEARCH_EVIDENCE_CAPABILITY, {
		attach: async (tenantId, ownerModule, recordRef, evidenceIds) =>
			(await service()).attach(tenantId, ownerModule, recordRef, evidenceIds),
		list: async (tenantId, ownerModule, recordRef) =>
			(await service()).listAttached(tenantId, ownerModule, recordRef),
		get: async (tenantId, id) => (await service()).getEvidence(tenantId, id),
	});
	context.agentTools.register(researchAgentTools(runtime));
	context.agentTools.registerNative(researchNativeTool(runtime));
	context.dataClasses.declare(RESEARCH_MODULE_ID, researchDataClasses(service));

	/* Both registries are optional and an optional requirement does not order
	   its provider first, so each is asked for while this module composes and
	   again at start, before its provider seals it. Without either provider
	   both attempts answer nothing and the module works the same. */
	let metersDeclared = false;
	let listsRegistered = false;
	const registerOptional = (): void => {
		const registry = meters();
		if (!metersDeclared && registry) {
			metersDeclared = true;
			registry.declare(RESEARCH_MODULE_ID, [
				{
					key: 'queries',
					label: 'Research queries',
					unit: 'queries',
					kind: 'cumulative',
				},
			]);
		}
		const lists = capabilities.get<ExportListRegistry>(EXPORT_LISTS_CAPABILITY);
		if (!listsRegistered && lists) {
			listsRegistered = true;
			lists.register(RESEARCH_MODULE_ID, researchListExports(service));
		}
	};
	registerOptional();
	return {
		routes: createResearchRoutes(context.auth, runtime),
		settings: RESEARCH_MODULE_SETTINGS,
		start: () => registerOptional(),
		dispose: () => runtime.dispose(),
	};
}
