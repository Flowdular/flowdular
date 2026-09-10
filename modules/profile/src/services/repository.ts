import type { Profile, ProfileLanguagePreference } from '../domain/types.ts';

export interface ProfileRepository {
	find(tenantId: string, accountId: string): Promise<Profile | null>;
	save(profile: Profile): Promise<Profile>;
	findLanguage(
		tenantId: string,
		accountId: string,
	): Promise<ProfileLanguagePreference | null>;
	saveLanguage(
		preference: ProfileLanguagePreference,
	): Promise<ProfileLanguagePreference>;
}
