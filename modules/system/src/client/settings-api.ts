import type { ModuleSettingValue } from '@coreloom/kernel';
import { t } from '@coreloom/client/i18n';
import type {
	SettingsEntryPayload,
	SettingsModulePayload,
} from '../server/endpoints.ts';
import { ApiError } from './api.ts';

export type { SettingsEntryPayload, SettingsModulePayload };

async function payload<T>(response: Response, fallback: string): Promise<T> {
	const value = (await response.json()) as T & {
		readonly error?: { readonly message?: string };
	};
	if (!response.ok) {
		throw new ApiError(response.status, value.error?.message ?? fallback);
	}
	return value;
}

export async function loadSettings(): Promise<
	readonly SettingsModulePayload[]
> {
	const response = await fetch('/api/settings', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (
		await payload<{ readonly modules: readonly SettingsModulePayload[] }>(
			response,
			t('system.settings.errorLoad'),
		)
	).modules;
}

export async function updateSetting(
	moduleId: string,
	key: string,
	value: ModuleSettingValue | null,
	csrfToken: string,
): Promise<SettingsEntryPayload | null> {
	const response = await fetch('/api/settings/update', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify({ moduleId, key, value }),
	});
	return (
		await payload<{ readonly setting: SettingsEntryPayload | null }>(
			response,
			t('system.settings.errorSave'),
		)
	).setting;
}
