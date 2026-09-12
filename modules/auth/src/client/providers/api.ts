import { t } from '@flowdular/client/i18n';
import type {
	IdentityProviderStatus,
	IdentityProviderSummary,
} from '../../domain/types.ts';
import { AuthClientApiError } from '../api.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

/** What the form sends. The secret travels once and is never sent back. */
export interface IdentityProviderRequest {
	readonly id?: string;
	readonly key?: string;
	readonly label: string;
	readonly issuer: string;
	readonly clientId: string;
	readonly clientSecret?: string;
	readonly scopes: readonly string[];
	readonly jitEnabled: boolean;
	readonly allowedDomains: readonly string[];
	readonly jitRole: string;
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		/* The status is what separates a refused read from a broken one, so the
		   screen can show the denied state for the first and a retry for the
		   second. */
		throw new AuthClientApiError(
			response.status,
			value.error?.message ?? t('auth.providers.error.request'),
		);
	}
	return value;
}

function post<T>(path: string, body: unknown, csrfToken: string): Promise<T> {
	return fetch(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
		credentials: 'same-origin',
		body: JSON.stringify(body),
	}).then(payload<T>);
}

export async function loadIdentityProviders(): Promise<
	readonly IdentityProviderSummary[]
> {
	const response = await fetch('/api/auth/providers', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (
		await payload<{ readonly providers: readonly IdentityProviderSummary[] }>(
			response,
		)
	).providers;
}

export async function createIdentityProvider(
	input: IdentityProviderRequest,
	csrfToken: string,
): Promise<IdentityProviderSummary> {
	return (
		await post<{ readonly provider: IdentityProviderSummary }>(
			'/api/auth/providers',
			input,
			csrfToken,
		)
	).provider;
}

export async function updateIdentityProvider(
	input: IdentityProviderRequest,
	csrfToken: string,
): Promise<IdentityProviderSummary> {
	return (
		await post<{ readonly provider: IdentityProviderSummary }>(
			'/api/auth/providers/update',
			input,
			csrfToken,
		)
	).provider;
}

export async function setIdentityProviderStatus(
	id: string,
	status: IdentityProviderStatus,
	csrfToken: string,
): Promise<IdentityProviderSummary> {
	return (
		await post<{ readonly provider: IdentityProviderSummary }>(
			status === 'active'
				? '/api/auth/providers/enable'
				: '/api/auth/providers/disable',
			{ id },
			csrfToken,
		)
	).provider;
}

export async function rotateIdentityProviderSecret(
	id: string,
	clientSecret: string,
	csrfToken: string,
): Promise<IdentityProviderSummary> {
	return (
		await post<{ readonly provider: IdentityProviderSummary }>(
			'/api/auth/providers/rotate-secret',
			{ id, clientSecret },
			csrfToken,
		)
	).provider;
}

export async function deleteIdentityProvider(
	id: string,
	csrfToken: string,
): Promise<void> {
	await post<{ readonly deleted: boolean }>(
		'/api/auth/providers/delete',
		{ id },
		csrfToken,
	);
}
