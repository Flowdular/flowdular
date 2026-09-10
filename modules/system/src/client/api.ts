import type { ModuleCatalogEntry } from '../server/module-catalog.ts';
import { t } from '@flowdular/client/i18n';

export type { ModuleCatalogEntry };

export interface ModuleCatalog {
	readonly modules: readonly ModuleCatalogEntry[];
	readonly commands: Readonly<Record<string, string>>;
}

export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

export async function loadModuleCatalog(): Promise<ModuleCatalog> {
	const response = await fetch('/api/system/modules', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	const value = (await response.json()) as ModuleCatalog & {
		readonly error?: { readonly message?: string };
	};
	if (!response.ok) {
		throw new ApiError(
			response.status,
			value.error?.message ?? t('system.error.catalog'),
		);
	}
	return value;
}
