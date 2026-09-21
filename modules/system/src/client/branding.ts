import {
	applicationBrandingFrom,
	BRANDING_SETTING_KEYS,
	type ApplicationBranding,
} from '@flowdular/contracts';
import type { SettingsEntryPayload } from './settings-api.ts';

/**
 * The rows the Branding screen shows, in the order an operator reads them:
 * the identity first, the link preview last, which is not the order the module
 * declares them in. A key the running platform does not declare drops out
 * rather than rendering a row with nothing behind it.
 */
export function brandingSettings(
	settings: readonly SettingsEntryPayload[],
): readonly SettingsEntryPayload[] {
	const found = new Map(settings.map((setting) => [setting.key, setting]));
	return BRANDING_SETTING_KEYS.map((key) => found.get(key)).filter(
		(setting): setting is SettingsEntryPayload => setting !== undefined,
	);
}

/** What those rows currently mean, for the preview beside them. */
export function brandingOf(
	settings: readonly SettingsEntryPayload[],
): ApplicationBranding {
	const values: Record<string, unknown> = {};
	for (const setting of settings) values[setting.key] = setting.value;
	return applicationBrandingFrom(values);
}
