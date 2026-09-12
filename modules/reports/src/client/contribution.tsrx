import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import {
	REPORTS_SUMMARY_WIDGET,
	REPORTS_VIEWS,
	reportsNavigation,
} from './navigation.ts';
import { ReportsSummaryWidget } from './ReportsSummaryWidget.tsrx';
import { ReportsView } from './ReportsView.tsrx';

export interface ReportsClientContributionOptions {
	readonly csrfToken: string;
}

export function createReportsClientContribution(
	options: ReportsClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'reports.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: reportsNavigation,
		views: [
			{
				id: REPORTS_VIEWS.reports,
				render: () => <ReportsView csrfToken={options.csrfToken} />,
			},
		],
		widgets: [
			{
				...REPORTS_SUMMARY_WIDGET,
				render: () => <ReportsSummaryWidget />,
			},
		],
	};
}
