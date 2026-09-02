import { t, type ModuleClientContribution } from '@coreloom/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { WORKFLOWS_PERMISSIONS } from '../acl/permissions.ts';
import { WorkflowsView } from './WorkflowsView.tsrx';
import './workflows.css';

export interface WorkflowsClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createWorkflowsClientContribution(
	options: WorkflowsClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'workflows.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: [
			{
				id: 'workflows.navigation',
				viewId: 'workflows',
				group: 'Operations',
				get label() {
					return t('workflows.navigation.label');
				},
				glyph: 'modules',
				get description() {
					return t('workflows.navigation.description');
				},
				scope: WORKFLOWS_PERMISSIONS.read,
				order: 50,
			},
		],
		views: [
			{
				id: 'workflows',
				render: () =>
					<WorkflowsView
						csrfToken={options.csrfToken}
						canRead={options.scopes.includes(WORKFLOWS_PERMISSIONS.read)}
						canManage={options.scopes.includes(WORKFLOWS_PERMISSIONS.manage)}
						canPublish={options.scopes.includes(WORKFLOWS_PERMISSIONS.publish)}
						canReadRuns={options.scopes.includes(
							WORKFLOWS_PERMISSIONS.runsRead,
						)}
						canExecute={options.scopes.includes(
							WORKFLOWS_PERMISSIONS.runsExecute,
						)}
						canCancel={options.scopes.includes(
							WORKFLOWS_PERMISSIONS.runsCancel,
						)}
					/>,
			},
		],
	};
}
