import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { LimitsView } from './LimitsView.tsrx';
import {
	METERING_USAGE_WIDGET,
	METERING_VIEWS,
	meteringNavigation,
} from './navigation.ts';
import { UsageSummaryWidget } from './UsageSummaryWidget.tsrx';
import { UsageView } from './UsageView.tsrx';

export interface MeteringClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createMeteringClientContribution(
	options: MeteringClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'metering.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: meteringNavigation,
		views: [
			{
				id: METERING_VIEWS.usage,
				render: () => <UsageView csrfToken={options.csrfToken} />,
			},
			{
				id: METERING_VIEWS.limits,
				render: () => <LimitsView csrfToken={options.csrfToken} />,
			},
		],
		widgets: [
			{
				...METERING_USAGE_WIDGET,
				render: () => <UsageSummaryWidget />,
			},
		],
	};
}
