import { TENANT_TIME_ZONE_SETTING } from '@flowdular/contracts';
import type { ModuleSettingsRuntime } from '@flowdular/kernel';

/* Declared and owned by system.core as a shared tenant setting. automations
   reads it through the settings runtime, never through system.core storage, and
   addresses it by the id, key and fallback the shared contract names. */
export const TENANT_TIME_ZONE_MODULE_ID = TENANT_TIME_ZONE_SETTING.moduleId;
export const TENANT_TIME_ZONE_KEY = TENANT_TIME_ZONE_SETTING.key;
export const DEFAULT_TIME_ZONE = TENANT_TIME_ZONE_SETTING.defaultValue;

/* Spellings this runtime accepted, lower-cased so every spelling of a zone
   shares one entry, and capped like the formatter cache in cron.ts so a
   long-lived process cannot carry every value it was ever handed. */
const MAX_SUPPORTED_ZONES = 32;
const supported = new Set<string>([DEFAULT_TIME_ZONE.toLowerCase()]);

function isSupported(value: string): boolean {
	const spelling = value.toLowerCase();
	if (supported.has(spelling)) return true;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value });
	} catch {
		return false;
	}
	if (supported.size >= MAX_SUPPORTED_ZONES) supported.clear();
	supported.add(spelling);
	return true;
}

/**
 * The workspace zone a cron slot is computed in. A workspace that set nothing,
 * a deployment without system.core, and a stored name this runtime does not
 * know all resolve to UTC, because the scheduler must keep firing either way.
 */
export function tenantTimeZone(
	settings: ModuleSettingsRuntime,
	tenantId: string,
): string {
	let stored: string;
	try {
		stored = settings.get<string>(
			tenantId,
			TENANT_TIME_ZONE_MODULE_ID,
			TENANT_TIME_ZONE_KEY,
		);
	} catch {
		return DEFAULT_TIME_ZONE;
	}
	return isSupported(stored) ? stored : DEFAULT_TIME_ZONE;
}
