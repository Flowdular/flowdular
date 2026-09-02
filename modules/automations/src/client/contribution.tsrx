import { t, type ModuleClientContribution } from '@coreloom/client';
import { AUTOMATIONS_PERMISSIONS } from '../acl/permissions.ts';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { AutomationSchedulesView } from './AutomationSchedulesView.tsrx';
import { AutomationTriggersView } from './AutomationTriggersView.tsrx';

export interface AutomationsClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createAutomationsClientContribution(
	options: AutomationsClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'automations.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: [
			{
				id: 'automations.navigation.schedules',
				viewId: 'automation-schedules',
				group: 'Automations',
				get label() {
					return t('automations.nav.schedules.label');
				},
				glyph: 'activity',
				get description() {
					return t('automations.nav.schedules.description');
				},
				scope: AUTOMATIONS_PERMISSIONS.read,
				order: 10,
			},
			{
				id: 'automations.navigation.triggers',
				viewId: 'automation-triggers',
				group: 'Automations',
				get label() {
					return t('automations.nav.triggers.label');
				},
				glyph: 'plug',
				get description() {
					return t('automations.nav.triggers.description');
				},
				scope: AUTOMATIONS_PERMISSIONS.triggersRead,
				order: 20,
			},
		],
		views: [
			{
				id: 'automation-schedules',
				render: () =>
					<AutomationSchedulesView
						csrfToken={options.csrfToken}
						canManage={options.scopes.includes(AUTOMATIONS_PERMISSIONS.manage)}
					/>,
			},
			{
				id: 'automation-triggers',
				render: () =>
					<AutomationTriggersView
						csrfToken={options.csrfToken}
						canManage={options.scopes.includes(
							AUTOMATIONS_PERMISSIONS.triggersManage,
						)}
					/>,
			},
		],
	};
}
