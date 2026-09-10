import type { ModuleClientContribution } from '@flowdular/sdk/client';
import { EXAMPLE_PERMISSIONS } from '../acl/permissions.ts';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { NotesView } from './NotesView.tsrx';
import {
	exampleNavigationDescription,
	exampleNavigationLabel,
} from './navigation-copy.ts';

export interface ExampleClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createExampleClientContribution(
	options: ExampleClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'example.core',
		translations: { en: translationsEn, pl: translationsPl },
		navigation: [
			{
				id: 'example.navigation',
				viewId: 'example',
				group: 'Operations',
				/* The shell registers this contribution's bundles after the factory
   returns. Getters resolve copy only when the shell reads navigation,
   after registration, and again when the active locale changes. */
				get label() {
					return exampleNavigationLabel();
				},
				glyph: 'file-text',
				get description() {
					return exampleNavigationDescription();
				},
				scope: EXAMPLE_PERMISSIONS.read,
				order: 20,
			},
		],
		views: [
			{
				id: 'example',
				render: () =>
					<NotesView
						csrfToken={options.csrfToken}
						canManage={options.scopes.includes(EXAMPLE_PERMISSIONS.manage)}
					/>,
			},
		],
	};
}
