import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { AUDIT_PERMISSIONS } from '../acl/permissions.ts';
import { DataClassesView } from './DataClassesView.tsrx';
import { ExportsView } from './ExportsView.tsrx';
import { HoldsView } from './HoldsView.tsrx';
import { auditNavigation, AUDIT_VIEWS } from './navigation.ts';
import { SweepsView } from './SweepsView.tsrx';

export interface AuditClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createAuditClientContribution(
	options: AuditClientContributionOptions,
): ModuleClientContribution {
	const canManage = options.scopes.includes(AUDIT_PERMISSIONS.retentionManage);
	const canManageHolds = options.scopes.includes(AUDIT_PERMISSIONS.holdsManage);
	return {
		moduleId: 'audit.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: auditNavigation,
		views: [
			{
				id: AUDIT_VIEWS.dataClasses,
				render: () =>
					<DataClassesView
						csrfToken={options.csrfToken}
						canManage={canManage}
					/>,
			},
			{
				id: AUDIT_VIEWS.sweeps,
				render: () => <SweepsView csrfToken={options.csrfToken} />,
			},
			{
				id: AUDIT_VIEWS.exports,
				render: () => <ExportsView csrfToken={options.csrfToken} />,
			},
			{
				id: AUDIT_VIEWS.holds,
				render: () =>
					<HoldsView
						csrfToken={options.csrfToken}
						canManage={canManageHolds}
					/>,
			},
		],
	};
}
