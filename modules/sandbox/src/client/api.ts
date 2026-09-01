import type {
	SandboxAccessCandidate,
	SandboxAccessGrant,
	SandboxSessionRecord,
} from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

export interface SandboxAccessSnapshot {
	readonly sandbox: { readonly url: string };
	readonly grants: readonly SandboxAccessGrant[];
	readonly candidates: readonly SandboxAccessCandidate[];
}

export interface GrantSandboxAccessRequest {
	readonly accountId: string;
	readonly capabilities: readonly string[];
	readonly expiresAt: number | null;
	readonly note: string | null;
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(value.error?.message ?? 'The sandbox operation failed.');
	}
	return value;
}

export async function loadSandboxAccess(): Promise<SandboxAccessSnapshot> {
	const response = await fetch('/api/sandbox/access', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return payload<SandboxAccessSnapshot>(response);
}

export async function loadSandboxSessions(): Promise<
	readonly SandboxSessionRecord[]
> {
	const response = await fetch('/api/sandbox/sessions', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (
		await payload<{ readonly sessions: readonly SandboxSessionRecord[] }>(
			response,
		)
	).sessions;
}

export async function grantSandboxAccess(
	input: GrantSandboxAccessRequest,
	csrfToken: string,
): Promise<SandboxAccessGrant> {
	const response = await fetch('/api/sandbox/access', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	return (await payload<{ readonly grant: SandboxAccessGrant }>(response))
		.grant;
}

export async function revokeSandboxAccess(
	accountId: string,
	csrfToken: string,
): Promise<SandboxAccessGrant> {
	const response = await fetch('/api/sandbox/access/revoke', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify({ accountId }),
	});
	return (await payload<{ readonly grant: SandboxAccessGrant }>(response))
		.grant;
}
