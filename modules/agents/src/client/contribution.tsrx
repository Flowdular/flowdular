import type { ModuleClientContribution } from '@coreloom/client';
import { AGENT_PERMISSIONS } from '../acl/permissions.ts';
import { AgentProvidersView } from './AgentProvidersView.tsrx';
import { AgentDashboardWidget } from './AgentDashboardWidget.tsrx';
import { AgentPlaygroundView } from './AgentPlaygroundView.tsrx';
import { AgentRunsView } from './AgentRunsView.tsrx';
import { AgentSkillsView } from './AgentSkillsView.tsrx';
import { AgentsView } from './AgentsView.tsrx';
import './agents.css';

export interface AgentClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createAgentClientContribution(
	options: AgentClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'agents.core',
		navigation: [
			{
				id: 'agents.navigation.providers',
				viewId: 'agent-providers',
				group: 'Agents',
				label: 'Providers',
				glyph: 'plug',
				description: 'Connections and readiness',
				scope: AGENT_PERMISSIONS.providersRead,
				order: 20,
			},
			{
				id: 'agents.navigation.skills',
				viewId: 'agent-skills',
				group: 'Agents',
				label: 'Skills',
				glyph: 'file-text',
				description: 'Reusable procedures',
				scope: AGENT_PERMISSIONS.skillsRead,
				order: 35,
			},
			{
				id: 'agents.navigation.playground',
				viewId: 'agent-playground',
				group: 'Agents',
				label: 'Agent playground',
				glyph: 'flask',
				description: 'Queue isolated test runs',
				scope: AGENT_PERMISSIONS.runsExecute,
				order: 40,
			},
			{
				id: 'agents.navigation.runs',
				viewId: 'agent-runs',
				group: 'Agents',
				label: 'Agent runs',
				glyph: 'activity',
				description: 'Durable execution history',
				scope: AGENT_PERMISSIONS.runsRead,
				order: 50,
			},
			{
				id: 'agents.navigation.definitions',
				viewId: 'agents',
				group: 'Agents',
				label: 'Agents',
				glyph: 'bot',
				description: 'Reusable worker definitions',
				scope: AGENT_PERMISSIONS.definitionsRead,
				order: 30,
			},
		],
		views: [
			{
				id: 'agent-providers',
				render: () => <AgentProvidersView csrfToken={options.csrfToken} />,
			},
			{
				id: 'agents',
				render: () =>
					<AgentsView
						csrfToken={options.csrfToken}
						canManage={options.scopes.includes(
							AGENT_PERMISSIONS.definitionsManage,
						)}
					/>,
			},
			{
				id: 'agent-skills',
				render: () =>
					<AgentSkillsView
						csrfToken={options.csrfToken}
						canManage={options.scopes.includes(AGENT_PERMISSIONS.skillsManage)}
					/>,
			},
			{
				id: 'agent-playground',
				render: () => <AgentPlaygroundView csrfToken={options.csrfToken} />,
			},
			{
				id: 'agent-runs',
				render: () =>
					<AgentRunsView
						csrfToken={options.csrfToken}
						canCancel={options.scopes.includes(AGENT_PERMISSIONS.runsExecute)}
					/>,
			},
		],
		widgets: [
			{
				id: 'agents.dashboard.queue',
				slot: 'dashboard.aside',
				scope: AGENT_PERMISSIONS.runsRead,
				order: 30,
				render: () => <AgentDashboardWidget />,
			},
		],
	};
}
