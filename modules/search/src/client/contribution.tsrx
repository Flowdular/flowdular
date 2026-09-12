import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import {
	createSearchCommandContribution,
	searchNavigation,
	SEARCH_VIEWS,
} from './navigation.ts';
import { SearchView } from './SearchView.tsrx';
import './search.css';

export interface SearchClientContributionOptions {
	readonly csrfToken: string;
}

export function createSearchClientContribution(
	options: SearchClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'search.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: searchNavigation,
		views: [
			{
				id: SEARCH_VIEWS.search,
				render: () => <SearchView csrfToken={options.csrfToken} />,
			},
		],
		commandSearch: createSearchCommandContribution(options.csrfToken),
	};
}
