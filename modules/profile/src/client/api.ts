import type { Profile, UpdateProfileInput } from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
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
		throw new Error(value?.error?.message ?? fallbackMessage);
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
			'Could not load your profile.',
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
			'Could not update your profile.',
		)
	).profile;
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
	await payload<unknown>(response, 'Could not change your password.');
}
