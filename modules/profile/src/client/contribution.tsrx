import {
	restoreAccountLocaleCache,
	setServerAccountLocale,
	t,
	type ModuleClientContribution,
} from '@coreloom/client';
import { PROFILE_PERMISSIONS } from '../acl/permissions.ts';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';
import { loadOwnLanguagePreference, ProfileClientError } from './api.ts';
import { ProfileView } from './ProfileView.tsrx';

export interface ProfileClientContributionOptions {
	readonly csrfToken: string;
}

export function createProfileClientContribution(
	options: ProfileClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'profile.core',
		translations: { en: translationsEn, pl: translationsPl },
		initialize: async ({ accountId, tenantId, signal }) => {
			restoreAccountLocaleCache(accountId, tenantId);
			try {
				const locale = await loadOwnLanguagePreference(signal);
				if (!signal.aborted) setServerAccountLocale(locale);
			} catch (error) {
				if (
					!signal.aborted && error instanceof ProfileClientError &&
						error.status < 500
				) {
					setServerAccountLocale(null);
				}
				/* A scoped browser value may keep the UI usable while offline. The
   next successful initialization always replaces it with server state. */
			}
		},
		accountMenu: [
			{
				id: 'profile.account-menu',
				viewId: 'profile',
				get label() {
					return t('profile.navigation.label');
				},
				get description() {
					return t('profile.navigation.description');
				},
				glyph: 'user',
				scope: PROFILE_PERMISSIONS.manageSelf,
				order: 10,
			},
		],
		views: [
			{
				id: 'profile',
				render: () => <ProfileView csrfToken={options.csrfToken} />,
			},
		],
	};
}
