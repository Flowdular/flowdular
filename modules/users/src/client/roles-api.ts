import type { TenantRole } from '@coreloom/module-auth';
import { ApiError } from './api.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

export interface RoleCatalog {
	readonly roles: readonly TenantRole[];
	readonly grantableScopes: readonly string[];
}

export interface RoleDraft {
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly scopes: readonly string[];
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new ApiError(
			response.status,
			value.error?.message ?? 'The role operation failed.',
		);
	}
	return value;
}

async function post<T>(
	path: string,
	body: unknown,
	csrfToken: string,
): Promise<T> {
	const response = await fetch(path, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify(body),
	});
	return payload<T>(response);
}

export async function loadRoles(): Promise<RoleCatalog> {
	const response = await fetch('/api/auth/roles', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return payload<RoleCatalog>(response);
}

export async function createRole(
	draft: RoleDraft,
	csrfToken: string,
): Promise<TenantRole> {
	return (
		await post<{ readonly role: TenantRole }>(
			'/api/auth/roles',
			draft,
			csrfToken,
		)
	).role;
}

export async function updateRole(
	id: string,
	draft: Omit<RoleDraft, 'key'>,
	csrfToken: string,
): Promise<TenantRole> {
	return (
		await post<{ readonly role: TenantRole }>(
			'/api/auth/roles/update',
			{ id, ...draft },
			csrfToken,
		)
	).role;
}

export async function deleteRole(id: string, csrfToken: string): Promise<void> {
	await post<{ readonly deleted: boolean }>(
		'/api/auth/roles/delete',
		{ id },
		csrfToken,
	);
}
