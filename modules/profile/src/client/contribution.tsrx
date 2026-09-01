import type { ModuleClientContribution } from '@coreloom/client';
import { PROFILE_PERMISSIONS } from '../acl/permissions.ts';
import { ProfileView } from './ProfileView.tsrx';

export interface ProfileClientContributionOptions {
	readonly csrfToken: string;
}

export function createProfileClientContribution(
	options: ProfileClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'profile.core',
		accountMenu: [
			{
				id: 'profile.account-menu',
				viewId: 'profile',
				label: 'Profile',
				description: 'Display name and password',
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
