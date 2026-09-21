import {
	applicationBrandingFrom,
	BRANDING_SETTING_KEYS,
	DEFAULT_APPLICATION_BRANDING,
	type ApplicationBranding,
} from '@flowdular/contracts';
import {
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';
import { SYSTEM_MODULE_ID } from './time-zone.ts';

/**
 * The branding of this deployment, read from the platform settings on the
 * request path so a change an owner makes is served by the next document
 * without a restart. The platform tenant is primed at boot; a process that has
 * not got there yet, or a value that no longer fits its declaration, renders
 * the product defaults rather than refusing the page.
 */
export function brandingFromSettings(
	settings: ModuleSettingsRuntime,
): ApplicationBranding {
	const values: Record<string, unknown> = {};
	try {
		for (const key of BRANDING_SETTING_KEYS) {
			values[key] = settings.get<string>(
				PLATFORM_SETTINGS_TENANT,
				SYSTEM_MODULE_ID,
				key,
			);
		}
	} catch {
		return DEFAULT_APPLICATION_BRANDING;
	}
	return applicationBrandingFrom(values);
}
