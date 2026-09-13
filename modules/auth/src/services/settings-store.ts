import type { ModuleSettingsStore } from '@flowdular/kernel';
import type { AuthRepository } from './repository.ts';

/**
 * The kernel settings store over auth.core's module_settings table. The
 * kernel runtime primes a snapshot per tenant through `load` and awaits every
 * write, so a failure reaches the caller that made it.
 */
export function createAuthSettingsStore(
	repository: () => Promise<AuthRepository>,
): ModuleSettingsStore {
	return {
		load: async (tenantId, moduleId) =>
			(await repository()).loadSettings(tenantId, moduleId),
		save: async (record) => (await repository()).saveSetting(record),
		clear: async (tenantId, moduleId, key) =>
			(await repository()).clearSetting(tenantId, moduleId, key),
	};
}
