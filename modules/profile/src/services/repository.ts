import type { Profile, ProfileLanguagePreference } from '../domain/types.ts';

export interface ProfileRepository {
	find(tenantId: string, accountId: string): Profile | null;
	save(profile: Profile): Profile;
	findLanguage(
		tenantId: string,
		accountId: string,
	): ProfileLanguagePreference | null;
	saveLanguage(
		preference: ProfileLanguagePreference,
	): ProfileLanguagePreference;
}
