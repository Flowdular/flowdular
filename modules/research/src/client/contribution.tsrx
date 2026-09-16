import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { RESEARCH_PERMISSIONS } from '../acl/permissions.ts';
import {
	evidenceIdFromLocation,
	RESEARCH_VIEWS,
	researchNavigation,
} from './navigation.ts';
import { ResearchView } from './ResearchView.tsrx';
import './research.css';

export interface ResearchClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createResearchClientContribution(
	options: ResearchClientContributionOptions = { csrfToken: '', scopes: [] },
): ModuleClientContribution {
	const canManage = options.scopes.includes(RESEARCH_PERMISSIONS.settings);
	return {
		moduleId: 'research.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: researchNavigation,
		views: [
			{
				id: RESEARCH_VIEWS.research,
				render: () =>
					<ResearchView
						initialTab="evidence"
						evidenceId={null}
						csrfToken={options.csrfToken}
						canManage={canManage}
					/>,
			},
			{
				id: RESEARCH_VIEWS.evidence,
				render: () =>
					<ResearchView
						initialTab="evidence"
						evidenceId={evidenceIdFromLocation()}
						csrfToken={options.csrfToken}
						canManage={canManage}
					/>,
			},
		],
	};
}
