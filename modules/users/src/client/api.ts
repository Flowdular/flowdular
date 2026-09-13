import type { TenantMember, TenantMemberSort } from '@flowdular/module-auth';
import { t } from '@flowdular/client/i18n';
import type {
	CreateUserInput,
	MemberBulkOutcome,
	UsersContext,
} from '../services/users-service.ts';

interface ErrorEnvelope {
	readonly error?: { readonly code?: string; readonly message?: string };
}

export class ApiError extends Error {
	readonly status: number;
	/** Stable server code; '' when the response carried none. */
	readonly code: string;

	constructor(status: number, message: string, code = '') {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
	}
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new ApiError(
			response.status,
			value.error?.message ?? t('users.error.request'),
			value.error?.code ?? '',
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

/* exports.core owns the job, its file and the screen that hands it over, so the
   Members screen only starts one: what comes back is the job as that screen
   will show it, and nothing here models it. */
export async function startListExport(
	list: string,
	csrfToken: string,
): Promise<void> {
	await post<unknown>('/api/exports/start', { list }, csrfToken);
}

export interface MemberListRequest {
	readonly sort: TenantMemberSort;
	readonly direction: 'asc' | 'desc';
	readonly limit: number;
	/** A prefix of the display name or the address; '' narrows nothing. */
	readonly query: string;
	readonly status: '' | 'active' | 'disabled';
	/** The cursor that opens this page; null asks for the first one. */
	readonly cursor: string | null;
}

export interface MemberListPage {
	readonly items: readonly TenantMember[];
	readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

/** One server-sorted, server-narrowed, server-paged listing; the screen narrows nothing. */
export async function loadTenantUsers(
	request: MemberListRequest,
): Promise<MemberListPage> {
	const parameters = new URLSearchParams({
		sort: request.sort,
		direction: request.direction,
		limit: String(request.limit),
	});
	if (request.query !== '') parameters.set('q', request.query);
	if (request.status !== '') parameters.set('status', request.status);
	if (request.cursor !== null) parameters.set('cursor', request.cursor);
	const response = await fetch('/api/users?' + parameters.toString(), {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return payload<MemberListPage>(response);
}

export async function loadUsersContext(): Promise<UsersContext> {
	const response = await fetch('/api/users/context', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return payload<UsersContext>(response);
}

export async function createTenantUser(
	input: CreateUserInput,
	csrfToken: string,
): Promise<TenantMember> {
	return (
		await post<{ readonly user: TenantMember }>('/api/users', input, csrfToken)
	).user;
}

export async function inviteTenantMember(
	input: { readonly email: string; readonly role: string },
	csrfToken: string,
): Promise<{ readonly id: string; readonly expiresAt: number }> {
	return (
		await post<{
			readonly invitation: { readonly id: string; readonly expiresAt: number };
		}>('/api/auth/invitations', input, csrfToken)
	).invitation;
}

type MemberResponse = { readonly user: TenantMember };

export async function renameMember(
	accountId: string,
	displayName: string,
	csrfToken: string,
): Promise<TenantMember> {
	return (
		await post<MemberResponse>(
			'/api/users/update',
			{ accountId, displayName },
			csrfToken,
		)
	).user;
}

export async function assignMemberRole(
	accountId: string,
	role: string,
	csrfToken: string,
): Promise<TenantMember> {
	return (
		await post<MemberResponse>(
			'/api/users/role',
			{ accountId, role },
			csrfToken,
		)
	).user;
}

/* The operator's global account block reaches every workspace the account
   belongs to, so no workspace screen calls it and this client has no fetch for
   POST /api/users/status. The drawer shows the account state read-only and
   changes workspace access through setMembershipStatus below. */

export interface MembershipStatusResult {
	readonly accountId: string;
	readonly status: 'active' | 'disabled';
}

/* Access to this workspace only. auth.core owns the membership and enforces the
   self-target and last-owner rules, so the call goes to its administration
   route directly, as the invitation and session routes above do. */
export async function setMembershipStatus(
	accountId: string,
	status: 'active' | 'disabled',
	csrfToken: string,
): Promise<MembershipStatusResult> {
	return (
		await post<{ readonly membership: MembershipStatusResult }>(
			'/api/auth/memberships/status',
			{ accountId, status },
			csrfToken,
		)
	).membership;
}

type OutcomesResponse = { readonly outcomes: readonly MemberBulkOutcome[] };

/* Workspace access for the selected rows, one outcome per id. */
export async function setMembershipStatusMany(
	accountIds: readonly string[],
	status: 'active' | 'disabled',
	csrfToken: string,
): Promise<readonly MemberBulkOutcome[]> {
	return (
		await post<OutcomesResponse>(
			'/api/users/status-many',
			{ accountIds, status },
			csrfToken,
		)
	).outcomes;
}

export async function assignRoleMany(
	accountIds: readonly string[],
	role: string,
	csrfToken: string,
): Promise<readonly MemberBulkOutcome[]> {
	return (
		await post<OutcomesResponse>(
			'/api/users/role-many',
			{ accountIds, role },
			csrfToken,
		)
	).outcomes;
}

export async function removeMember(
	accountId: string,
	csrfToken: string,
): Promise<void> {
	await post<{ readonly removed: boolean }>(
		'/api/users/remove',
		{ accountId },
		csrfToken,
	);
}

export async function resetMemberPassword(
	accountId: string,
	temporaryPassword: string,
	csrfToken: string,
): Promise<TenantMember> {
	return (
		await post<MemberResponse>(
			'/api/users/password-reset',
			{ accountId, temporaryPassword },
			csrfToken,
		)
	).user;
}

export async function setMemberScopes(
	accountId: string,
	scopes: readonly string[],
	csrfToken: string,
): Promise<TenantMember> {
	return (
		await post<MemberResponse>(
			'/api/users/scopes',
			{ accountId, scopes },
			csrfToken,
		)
	).user;
}

export async function revokeMemberSessions(
	accountId: string,
	csrfToken: string,
): Promise<number> {
	return (
		await post<{ readonly revoked: number }>(
			'/api/auth/sessions/revoke',
			{ accountId },
			csrfToken,
		)
	).revoked;
}
