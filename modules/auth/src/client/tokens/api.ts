import type { ApiTokenRecord, IssuedApiToken } from '../../domain/types.ts';
import { t } from '@flowdular/client/i18n';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

export interface ApiTokenSnapshot {
	readonly tokens: readonly ApiTokenRecord[];
	readonly availableScopes: readonly string[];
}

export interface CreateApiTokenRequest {
	readonly label: string;
	readonly scopes: readonly string[];
	readonly expiresAt: number | null;
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(value.error?.message ?? t('auth.tokens.error.request'));
	}
	return value;
}

export async function loadApiTokens(): Promise<ApiTokenSnapshot> {
	const response = await fetch('/api/auth/api-tokens', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return payload<ApiTokenSnapshot>(response);
}

export async function createApiToken(
	input: CreateApiTokenRequest,
	csrfToken: string,
): Promise<IssuedApiToken> {
	const response = await fetch('/api/auth/api-tokens', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	return payload<IssuedApiToken>(response);
}

export async function revokeApiToken(
	id: string,
	csrfToken: string,
): Promise<ApiTokenRecord> {
	const response = await fetch('/api/auth/api-tokens/revoke', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
		credentials: 'same-origin',
		body: JSON.stringify({ id }),
	});
	return (await payload<{ readonly token: ApiTokenRecord }>(response)).token;
}
