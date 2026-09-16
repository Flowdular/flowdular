import { type ModuleClientContribution } from '@flowdular/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import {
	evidenceIdFromLocation,
	RESEARCH_VIEWS,
	researchNavigation,
} from './navigation.ts';
import { ResearchView } from './ResearchView.tsrx';
import './research.css';

export function createResearchClientContribution(): ModuleClientContribution {
	return {
		moduleId: 'research.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: researchNavigation,
		views: [
			{
				id: RESEARCH_VIEWS.research,
				render: () => <ResearchView initialTab="evidence" evidenceId={null} />,
			},
			{
				id: RESEARCH_VIEWS.evidence,
				render: () =>
					<ResearchView
						initialTab="evidence"
						evidenceId={evidenceIdFromLocation()}
					/>,
			},
		],
	};
}
