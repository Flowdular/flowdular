import type { Profile } from '../domain/types.ts';

export interface ProfileRepository {
	find(tenantId: string, accountId: string): Profile | null;
	save(profile: Profile): Profile;
}
