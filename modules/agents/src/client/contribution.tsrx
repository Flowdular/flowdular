import { t, type ModuleClientContribution } from '@flowdular/client';
import { AGENT_PERMISSIONS } from '../acl/permissions.ts';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { AgentProvidersView } from './AgentProvidersView.tsrx';
import { AgentDashboardWidget } from './AgentDashboardWidget.tsrx';
import { AgentPlaygroundView } from './AgentPlaygroundView.tsrx';
import { AgentRunsView } from './AgentRunsView.tsrx';
import { AgentProceduresView } from './AgentProceduresView.tsrx';
import { AgentsView } from './AgentsView.tsrx';
import { AgentUsageView } from './AgentUsageView.tsrx';
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
		translations: { en: translationsEn, pl: translationsPl },
		navigation: [
			{
				id: 'agents.navigation.providers',
				viewId: 'agent-providers',
				group: 'Agents',
				get label() {
					return t('agents.navigation.providers');
				},
				glyph: 'plug',
				get description() {
					return t('agents.navigation.providersDescription');
				},
				scope: AGENT_PERMISSIONS.providersRead,
				order: 20,
			},
			{
				id: 'agents.navigation.procedures',
				viewId: 'agent-procedures',
				group: 'Agents',
				get label() {
					return t('agents.navigation.procedures');
				},
				glyph: 'file-text',
				get description() {
					return t('agents.navigation.proceduresDescription');
				},
				scope: AGENT_PERMISSIONS.proceduresRead,
				order: 35,
			},
			{
				id: 'agents.navigation.playground',
				viewId: 'agent-playground',
				group: 'Agents',
				get label() {
					return t('agents.navigation.playground');
				},
				glyph: 'flask',
				get description() {
					return t('agents.navigation.playgroundDescription');
				},
				scope: AGENT_PERMISSIONS.runsExecute,
				order: 40,
			},
			{
				id: 'agents.navigation.runs',
				viewId: 'agent-runs',
				group: 'Agents',
				get label() {
					return t('agents.navigation.runs');
				},
				glyph: 'activity',
				get description() {
					return t('agents.navigation.runsDescription');
				},
				scope: AGENT_PERMISSIONS.runsRead,
				order: 50,
			},
			{
				id: 'agents.navigation.definitions',
				viewId: 'agents',
				group: 'Agents',
				get label() {
					return t('agents.navigation.agents');
				},
				glyph: 'bot',
				get description() {
					return t('agents.navigation.agentsDescription');
				},
				scope: AGENT_PERMISSIONS.definitionsRead,
				order: 30,
			},
			{
				id: 'agents.navigation.usage',
				viewId: 'agent-usage',
				group: 'Agents',
				get label() {
					return t('agents.navigation.usage');
				},
				glyph: 'download',
				get description() {
					return t('agents.navigation.usageDescription');
				},
				scope: AGENT_PERMISSIONS.runsRead,
				order: 80,
			},
		],
		views: [
			{
				id: 'agent-providers',
				render: () =>
					<AgentProvidersView
						csrfToken={options.csrfToken}
						canManage={options.scopes.includes(
							AGENT_PERMISSIONS.providersManage,
						)}
					/>,
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
				id: 'agent-procedures',
				render: () =>
					<AgentProceduresView
						csrfToken={options.csrfToken}
						canManage={options.scopes.includes(
							AGENT_PERMISSIONS.proceduresManage,
						)}
					/>,
			},
			/* The former deep link keeps resolving. It is a view without a
   navigation entry, so the group still shows one Procedures item. */
			{
				id: 'agent-skills',
				render: () =>
					<AgentProceduresView
						csrfToken={options.csrfToken}
						canManage={options.scopes.includes(
							AGENT_PERMISSIONS.proceduresManage,
						)}
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
			{
				id: 'agent-usage',
				render: () => <AgentUsageView />,
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
