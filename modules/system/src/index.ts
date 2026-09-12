import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { SYSTEM_PERMISSIONS } from './acl/permissions.ts';

export const systemModule = {
	manifest: manifest as ModuleManifest,
	navigation: [],
	permissions: Object.values(SYSTEM_PERMISSIONS),
} satisfies RegisteredModule;

export { SYSTEM_PERMISSIONS } from './acl/permissions.ts';
export { SYSTEM_MODULE_SETTINGS } from './settings.ts';
export {
	DEFAULT_TIME_ZONE,
	InvalidTimeZoneError,
	isSupportedTimeZone,
	MAX_TIME_ZONE_LENGTH,
	normalizeTimeZone,
	resolveTimeZone,
	SYSTEM_MODULE_ID,
	TENANT_TIME_ZONE_KEY,
	tenantTimeZone,
} from './domain/time-zone.ts';
