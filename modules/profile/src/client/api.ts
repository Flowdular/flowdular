import type {
	Profile,
	ProfileLanguagePreference,
	UpdateProfileInput,
} from '../domain/types.ts';
import { t } from '@flowdular/client/i18n';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

export class ProfileClientError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = 'ProfileClientError';
	}
}

export interface ChangePasswordInput {
	readonly currentPassword: string;
	readonly newPassword: string;
}

async function payload<T>(
	response: Response,
	fallbackMessage: string,
): Promise<T> {
	const text = await response.text();
	let value: (T & ErrorEnvelope) | undefined;
	if (text) {
		try {
			value = JSON.parse(text) as T & ErrorEnvelope;
		} catch {
			if (response.ok) return {} as T;
		}
	}
	if (!response.ok) {
		throw new ProfileClientError(
			value?.error?.message ?? fallbackMessage,
			response.status,
		);
	}
	return (value ?? {}) as T;
}

export async function loadOwnProfile(): Promise<Profile | null> {
	const response = await fetch('/api/profile', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (
		await payload<{ readonly profile: Profile | null }>(
			response,
			t('profile.error.load'),
		)
	).profile;
}

export async function updateOwnProfile(
	input: UpdateProfileInput,
	csrfToken: string,
): Promise<Profile> {
	const response = await fetch('/api/profile', {
		method: 'PUT',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	return (
		await payload<{ readonly profile: Profile }>(
			response,
			t('profile.error.update'),
		)
	).profile;
}

export async function loadOwnLanguagePreference(
	signal?: AbortSignal,
): Promise<string | null> {
	const response = await fetch('/api/profile/language', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
		...(signal ? { signal } : {}),
	});
	return (
		await payload<{ readonly locale: string | null }>(
			response,
			t('profile.error.languageLoad'),
		)
	).locale;
}

export async function updateOwnLanguagePreference(
	locale: string,
	csrfToken: string,
): Promise<ProfileLanguagePreference> {
	const response = await fetch('/api/profile/language', {
		method: 'PUT',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify({ locale }),
	});
	return (
		await payload<{ readonly preference: ProfileLanguagePreference }>(
			response,
			t('profile.error.languageSave'),
		)
	).preference;
}

export async function changeOwnPassword(
	input: ChangePasswordInput,
	csrfToken: string,
): Promise<void> {
	const response = await fetch('/api/auth/password', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	await payload<unknown>(response, t('profile.error.password'));
}
