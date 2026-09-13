import { t } from '@flowdular/client/i18n';
import type {
	GroupSortKey,
	IssuedScimToken,
	ListDirection,
	ProvisioningEvent,
	ProvisioningOperation,
	ProvisioningOutcome,
	ScimGroupMapping,
	ScimToken,
	ScimTokenStatus,
	TokenSortKey,
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

/** One page of a screen list; the cursor is opaque and the server's own. */
export interface ListPagePayload<Record> {
	readonly items: readonly Record[];
	readonly page: { readonly nextCursor: string | null };
}

interface ListRequest<Key extends string> {
	readonly q: string;
	readonly sort: Key;
	readonly direction: ListDirection;
	readonly cursor: string | null;
	readonly limit: number;
}

function listSearch(
	request: ListRequest<string>,
	extra: Readonly<Record<string, string>> = {},
): string {
	const parameters = new URLSearchParams();
	if (request.q !== '') parameters.set('q', request.q);
	for (const [key, value] of Object.entries(extra)) {
		if (value !== '') parameters.set(key, value);
	}
	parameters.set('sort', request.sort);
	parameters.set('direction', request.direction);
	parameters.set('limit', String(request.limit));
	if (request.cursor !== null) parameters.set('cursor', request.cursor);
	return '?' + parameters.toString();
}

export interface TokenListRequest extends ListRequest<TokenSortKey> {
	readonly status: ScimTokenStatus | '';
}

export function loadScimTokens(
	request: TokenListRequest,
): Promise<ListPagePayload<ScimToken>> {
	return get<ListPagePayload<ScimToken>>(
		'/api/directory/tokens' + listSearch(request, { status: request.status }),
	);
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

export type GroupListRequest = ListRequest<GroupSortKey>;

export function loadGroupMappings(
	request: GroupListRequest,
): Promise<ListPagePayload<ScimGroupMapping>> {
	return get<ListPagePayload<ScimGroupMapping>>(
		'/api/directory/groups' + listSearch(request),
	);
}

export interface GroupMappingContextPayload {
	readonly roles: readonly string[];
	readonly defaultRole: string;
}

/** What the mapping form needs beside the rows: read once, not per page. */
export function loadGroupMappingContext(): Promise<GroupMappingContextPayload> {
	return get<GroupMappingContextPayload>('/api/directory/groups/context');
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
