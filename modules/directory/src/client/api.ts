import { t } from '@flowdular/client/i18n';
import type {
	IssuedScimToken,
	ProvisioningEvent,
	ProvisioningOperation,
	ProvisioningOutcome,
	ScimGroupMapping,
	ScimToken,
} from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
	};
}

/** A failed request with the server's stable code, so a screen can translate it. */
export class DirectoryApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'DirectoryApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * The server message is English and written for an operator. A code this module
 * knows becomes translated copy; anything else keeps the server's own sentence
 * rather than hiding what went wrong behind a generic line.
 */
export function directoryErrorMessage(
	error: unknown,
	fallbackKey: string,
): string {
	if (error instanceof DirectoryApiError) {
		const key = 'directory.error.code.' + error.code;
		const translated = t(key);
		if (translated !== key) return translated;
		return error.message;
	}
	if (error instanceof Error && error.message !== '') return error.message;
	return t(fallbackKey);
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new DirectoryApiError(
			response.status,
			value.error?.code ?? 'REQUEST_FAILED',
			value.error?.message ?? t('directory.error.request'),
		);
	}
	return value;
}

async function get<T>(path: string): Promise<T> {
	return payload<T>(
		await fetch(path, {
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		}),
	);
}

async function post<T>(
	path: string,
	body: unknown,
	csrfToken: string,
): Promise<T> {
	return payload<T>(
		await fetch(path, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-csrf-token': csrfToken,
			},
			credentials: 'same-origin',
			body: JSON.stringify(body),
		}),
	);
}

export async function loadScimTokens(): Promise<readonly ScimToken[]> {
	return (
		await get<{ readonly tokens: readonly ScimToken[] }>(
			'/api/directory/tokens',
		)
	).tokens;
}

export function createScimToken(
	input: { readonly label: string; readonly expiresAt: number | null },
	csrfToken: string,
): Promise<IssuedScimToken> {
	return post<IssuedScimToken>('/api/directory/tokens', input, csrfToken);
}

export function rotateScimToken(
	id: string,
	expiresAt: number | null,
	csrfToken: string,
): Promise<IssuedScimToken> {
	return post<IssuedScimToken>(
		'/api/directory/tokens/rotate',
		{ id, expiresAt },
		csrfToken,
	);
}

export async function revokeScimToken(
	id: string,
	csrfToken: string,
): Promise<ScimToken> {
	return (
		await post<{ readonly token: ScimToken }>(
			'/api/directory/tokens/revoke',
			{ id },
			csrfToken,
		)
	).token;
}

export interface GroupMappingsPayload {
	readonly groups: readonly ScimGroupMapping[];
	readonly roles: readonly string[];
	readonly defaultRole: string;
}

export function loadGroupMappings(): Promise<GroupMappingsPayload> {
	return get<GroupMappingsPayload>('/api/directory/groups');
}

export async function mapGroup(
	input: {
		readonly id: string;
		readonly roleKey: string | null;
		readonly precedence: number;
	},
	csrfToken: string,
): Promise<ScimGroupMapping> {
	return (
		await post<{ readonly group: ScimGroupMapping }>(
			'/api/directory/groups/map',
			input,
			csrfToken,
		)
	).group;
}

export interface ProvisioningEventPage {
	readonly items: readonly ProvisioningEvent[];
	readonly page: { readonly nextCursor: string | null };
}

export function loadProvisioningEvents(query: {
	readonly operation: ProvisioningOperation | '';
	readonly outcome: ProvisioningOutcome | '';
	readonly cursor: string | null;
}): Promise<ProvisioningEventPage> {
	const parameters = new URLSearchParams();
	if (query.operation !== '') parameters.set('operation', query.operation);
	if (query.outcome !== '') parameters.set('outcome', query.outcome);
	if (query.cursor !== null) parameters.set('cursor', query.cursor);
	const search = parameters.toString();
	return get<ProvisioningEventPage>(
		'/api/directory/provisioning-events' + (search === '' ? '' : '?' + search),
	);
}
