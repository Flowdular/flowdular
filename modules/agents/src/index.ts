import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { AGENT_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	/* Mirrors the client contribution in client/contribution.tsrx. */
	navigation: [
		{
			id: 'agents.navigation.providers',
			label: 'Providers',
			href: '/agent-providers',
			order: 20,
			permission: AGENT_PERMISSIONS.providersRead,
		},
		{
			id: 'agents.navigation.definitions',
			label: 'Agents',
			href: '/agents',
			order: 30,
			permission: AGENT_PERMISSIONS.definitionsRead,
		},
		{
			id: 'agents.navigation.procedures',
			label: 'Procedures',
			href: '/agent-procedures',
			order: 35,
			permission: AGENT_PERMISSIONS.proceduresRead,
		},
		{
			id: 'agents.navigation.playground',
			label: 'Agent playground',
			href: '/agent-playground',
			order: 40,
			permission: AGENT_PERMISSIONS.runsExecute,
		},
		{
			id: 'agents.navigation.runs',
			label: 'Agent runs',
			href: '/agent-runs',
			order: 50,
			permission: AGENT_PERMISSIONS.runsRead,
		},
		{
			id: 'agents.navigation.usage',
			label: 'Usage and cost',
			href: '/agent-usage',
			order: 80,
			permission: AGENT_PERMISSIONS.runsRead,
		},
	],
	permissions: Object.values(AGENT_PERMISSIONS),
} satisfies RegisteredModule;

export { AGENT_PERMISSIONS } from './acl/permissions.ts';
export { AGENTS_MODULE_SETTINGS } from './settings.ts';
export { AgentService, AgentServiceError } from './services/agent-service.ts';
export type {
	AgentDefinition,
	AgentRun,
	AgentRunDetail,
	AgentStatus,
	AgentUsageSummary,
	AgentWorkerStatus,
	CreateAgentInput,
	EnqueueAgentRunInput,
	UpdateAgentInput,
	AgentOwnership,
	TenantAgentView,
	ModuleAgentBinding,
	ModuleAgentDefinition,
	ModuleAgentDefinitionInput,
	ModuleAgentExecutionLimits,
	ModuleAgentView,
	UpdateModuleAgentBindingInput,
	AgentProcedure,
	AgentProcedureSnapshot,
	AgentProcedureStatus,
	AgentRevisionProcedure,
	CreateAgentProcedureInput,
	UpdateAgentProcedureInput,
	AgentSkill,
	AgentSkillSnapshot,
	AgentSkillStatus,
	AgentRevisionSkill,
	CreateAgentSkillInput,
	UpdateAgentSkillInput,
} from './domain/types.ts';
