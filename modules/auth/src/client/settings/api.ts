export interface LocaleSetting {
	readonly value: string;
	readonly defaultValue: string;
	readonly options: readonly string[];
	readonly hasValue: boolean;
}

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

/* The shape of one entry served by system.core's GET /api/settings; only the
   fields the workspace screen reads. */
interface WireSetting {
	readonly key: string;
	readonly value: unknown;
	readonly defaultValue: unknown;
	readonly hasValue: boolean;
	readonly enum?: readonly string[];
}

export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

async function payload<T>(response: Response, fallback: string): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new ApiError(response.status, value.error?.message ?? fallback);
	}
	return value;
}

function localeOf(entry: WireSetting | undefined): LocaleSetting | null {
	if (!entry) return null;
	return {
		value: typeof entry.value === 'string' ? entry.value : '',
		defaultValue:
			typeof entry.defaultValue === 'string' ? entry.defaultValue : '',
		options: entry.enum ?? [],
		hasValue: entry.hasValue === true,
	};
}

/* The default locale is the auth.core defaultLocale tenant setting; it is
   read and stored through the platform settings API served by system.core. */
export async function loadDefaultLocale(): Promise<LocaleSetting | null> {
	const response = await fetch('/api/settings', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	const body = await payload<{
		readonly modules: readonly {
			readonly moduleId: string;
			readonly settings: readonly WireSetting[];
		}[];
	}>(response, 'Could not load settings.');
	return localeOf(
		body.modules
			.find((module) => module.moduleId === 'auth.core')
			?.settings.find((setting) => setting.key === 'defaultLocale'),
	);
}

export async function updateDefaultLocale(
	value: string | null,
	csrfToken: string,
): Promise<LocaleSetting | null> {
	const response = await fetch('/api/settings/update', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify({
			moduleId: 'auth.core',
			key: 'defaultLocale',
			value,
		}),
	});
	const body = await payload<{ readonly setting: WireSetting | null }>(
		response,
		'Could not save the default locale.',
	);
	return localeOf(body.setting ?? undefined);
}

export async function renameWorkspace(
	name: string,
	csrfToken: string,
): Promise<{ readonly tenantId: string; readonly name: string }> {
	const response = await fetch('/api/auth/workspace', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify({ name }),
	});
	return (
		await payload<{
			readonly tenant: { readonly tenantId: string; readonly name: string };
		}>(response, 'Could not rename the workspace.')
	).tenant;
}
