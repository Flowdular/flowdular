import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { APPROVALS_PERMISSIONS } from '../acl/permissions.ts';
import { ApprovalsView } from './ApprovalsView.tsrx';
import {
	APPROVALS_PENDING_WIDGET,
	APPROVALS_VIEWS,
	approvalsNavigation,
} from './navigation.ts';
import { PendingCountWidget } from './PendingCountWidget.tsrx';
import './approvals.css';

export interface ApprovalsClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createApprovalsClientContribution(
	options: ApprovalsClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'approvals.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: approvalsNavigation,
		views: [
			{
				id: APPROVALS_VIEWS.inbox,
				render: () =>
					<ApprovalsView
						csrfToken={options.csrfToken}
						canManage={options.scopes.includes(APPROVALS_PERMISSIONS.manage)}
					/>,
			},
		],
		widgets: [
			{
				...APPROVALS_PENDING_WIDGET,
				render: () => <PendingCountWidget />,
			},
		],
	};
}
