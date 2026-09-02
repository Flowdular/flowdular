import { t, type Translate } from '@coreloom/client/i18n';
import type { SettingsEntryPayload } from './settings-api.ts';

export interface LocalizedSettingCopy {
	readonly label: string;
	readonly description: string;
	readonly locked: string | undefined;
}

/* Setting declarations cross the API before the active locale is known. The
   client resolves their optional keys and keeps server literals as a safe
   fallback for older or temporarily incomplete module bundles. */
export function translateSettingCopy(
	setting: SettingsEntryPayload,
	translate: Translate = t,
): LocalizedSettingCopy {
	const resolve = (key: string | undefined, fallback: string): string => {
		if (key === undefined) return fallback;
		const translated = translate(key);
		return translated === key ? fallback : translated;
	};
	return {
		label: resolve(setting.labelKey, setting.label),
		description: resolve(setting.descriptionKey, setting.description),
		locked:
			setting.locked === undefined
				? undefined
				: resolve(setting.lockedKey, setting.locked),
	};
}
