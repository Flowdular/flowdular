import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';
import type { SearchBudget } from './services/search-service.ts';

export const SEARCH_MODULE_ID = 'search.core';

export const SEARCH_MODULE_SETTINGS = defineModuleSettings({
	moduleId: SEARCH_MODULE_ID,
	settings: {
		providerTimeoutMs: {
			type: 'number',
			defaultValue: 1_500,
			min: 200,
			max: 10_000,
			visibility: 'shared',
			client: false,
			scope: 'platform',
			labelKey: 'search.settings.providerTimeoutMs.label',
			label: 'Provider time budget (ms)',
			descriptionKey: 'search.settings.providerTimeoutMs.description',
			description:
				'Time one provider gets per query before it is reported unavailable.',
		},
		hitsPerProvider: {
			type: 'number',
			defaultValue: 20,
			min: 5,
			max: 100,
			visibility: 'shared',
			client: false,
			scope: 'platform',
			labelKey: 'search.settings.hitsPerProvider.label',
			label: 'Hits per provider',
			descriptionKey: 'search.settings.hitsPerProvider.description',
			description: 'Hits one provider may answer with per page.',
		},
	},
});

const DEFAULTS = SEARCH_MODULE_SETTINGS.settings;

/* A settings read must never take a request down, so each accessor falls back
   to the declared default when the runtime has not registered it yet. */
function value(
	settings: ModuleSettingsRuntime,
	key: keyof typeof DEFAULTS,
	fallback: number,
): number {
	try {
		return settings.get<number>(
			PLATFORM_SETTINGS_TENANT,
			SEARCH_MODULE_ID,
			key,
		);
	} catch {
		return fallback;
	}
}

export function searchBudget(settings: ModuleSettingsRuntime): SearchBudget {
	return {
		providerTimeoutMs: value(settings, 'providerTimeoutMs', 1_500),
		hitsPerProvider: value(settings, 'hitsPerProvider', 20),
	};
}
