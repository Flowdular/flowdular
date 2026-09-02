import type {
	OverviewActivityPoint,
	OverviewModulePoint,
	SystemOverviewPayload,
} from '../server/endpoints.ts';
import { t } from '@coreloom/client/i18n';
import { ApiError } from './api.ts';

export type {
	OverviewActivityPoint,
	OverviewModulePoint,
	SystemOverviewPayload,
};

export async function loadSystemOverview(): Promise<SystemOverviewPayload> {
	const response = await fetch('/api/system/overview', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	const value = (await response.json()) as SystemOverviewPayload & {
		readonly error?: { readonly message?: string };
	};
	if (!response.ok) {
		throw new ApiError(
			response.status,
			value.error?.message ?? t('shell.overview.error'),
		);
	}
	return value;
}
