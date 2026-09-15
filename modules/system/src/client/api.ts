import type { ModuleCatalogPayload } from '../server/endpoints.ts';
import type { ModuleActivationEntry } from '../domain/modules.ts';
import { t } from '@flowdular/client/i18n';

export type ModuleCatalogEntry = ModuleCatalogPayload;

export interface ModuleCatalog {
	readonly modules: readonly ModuleCatalogEntry[];
	readonly commands: Readonly<Record<string, string>>;
}

export class ApiError extends Error {
	readonly status: number;
	/** The modules a refusal names, when the server named any. */
	readonly modules: readonly string[];

	constructor(
		status: number,
		message: string,
		modules: readonly string[] = [],
	) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.modules = modules;
	}
}

async function payload<T>(response: Response, fallback: string): Promise<T> {
	const value = (await response.json()) as T & {
		readonly error?: {
			readonly message?: string;
			readonly modules?: readonly string[];
		};
	};
	if (!response.ok) {
		throw new ApiError(
			response.status,
			value.error?.message ?? fallback,
			value.error?.modules ?? [],
		);
	}
	return value;
}

export async function loadModuleCatalog(): Promise<ModuleCatalog> {
	const response = await fetch('/api/system/modules', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return payload<ModuleCatalog>(response, t('system.error.catalog'));
}

export async function setModuleActivation(
	moduleId: string,
	active: boolean,
	csrfToken: string,
): Promise<ModuleActivationEntry> {
	const response = await fetch(
		active ? '/api/system/modules/activate' : '/api/system/modules/deactivate',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-csrf-token': csrfToken,
			},
			credentials: 'same-origin',
			body: JSON.stringify({ moduleId }),
		},
	);
	return (
		await payload<{ readonly module: ModuleActivationEntry }>(
			response,
			t('system.error.activation'),
		)
	).module;
}
