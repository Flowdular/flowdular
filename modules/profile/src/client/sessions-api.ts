import { t } from '@coreloom/client/i18n';

export interface OwnSession {
	readonly id: string;
	readonly tenantId: string;
	readonly tenantName: string;
	readonly createdAt: number;
	readonly lastSeenAt: number;
	readonly expiresAt: number;
	readonly current: boolean;
}

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

async function payload<T>(response: Response, fallback: string): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) throw new Error(value.error?.message ?? fallback);
	return value;
}

/* Sessions are auth.core data; profile.core only renders and revokes them
   through the auth endpoints, the same way it delegates password changes. */
export async function loadOwnSessions(): Promise<readonly OwnSession[]> {
	const response = await fetch('/api/auth/sessions', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (
		await payload<{ readonly sessions: readonly OwnSession[] }>(
			response,
			t('profile.sessions.errorLoad'),
		)
	).sessions;
}

export async function revokeOwnSession(
	id: string,
	csrfToken: string,
): Promise<void> {
	const response = await fetch('/api/auth/sessions/revoke', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify({ id }),
	});
	await payload<unknown>(response, t('profile.sessions.errorRevoke'));
}
