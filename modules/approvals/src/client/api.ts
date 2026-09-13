import { t } from '@flowdular/client/i18n';
import type {
	ApprovalDecideOutcome,
	ApprovalListDirection,
	ApprovalListSort,
	ApprovalRequest,
	ApprovalRequestView,
	ApprovalStatus,
} from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
	};
}

/** A failed request with the server's stable code, so a screen can translate it. */
export class ApprovalsApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'ApprovalsApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * The server message is English and written for an operator. A code this module
 * knows becomes translated copy; anything else keeps the server's own sentence
 * rather than hiding what went wrong behind a generic line.
 */
export function approvalsErrorMessage(
	error: unknown,
	fallbackKey: string,
): string {
	if (error instanceof ApprovalsApiError) {
		const key = 'approvals.error.code.' + error.code;
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
		throw new ApprovalsApiError(
			response.status,
			value.error?.code ?? 'REQUEST_FAILED',
			value.error?.message ?? t('approvals.error.request'),
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

function query(entries: Readonly<Record<string, string>>): string {
	const parameters = new URLSearchParams();
	for (const [key, value] of Object.entries(entries)) {
		if (value !== '') parameters.set(key, value);
	}
	const text = parameters.toString();
	return text === '' ? '' : '?' + text;
}

export type ApprovalsListScope = 'mine' | 'decidable' | 'all';

export interface ApprovalsFilter {
	readonly scope?: ApprovalsListScope;
	readonly status?: ApprovalStatus | '';
	readonly sort?: ApprovalListSort;
	readonly direction?: ApprovalListDirection;
	readonly limit?: number;
	/** The cursor that opens this page; none for the first page. */
	readonly cursor?: string | null;
}

export interface ApprovalsPage {
	readonly items: readonly ApprovalRequest[];
	/** Null once the last page is on screen. */
	readonly nextCursor: string | null;
}

export async function loadRequests(
	filter: ApprovalsFilter = {},
): Promise<ApprovalsPage> {
	const page = await get<{
		readonly items: readonly ApprovalRequest[];
		readonly page: { readonly nextCursor: string | null };
	}>(
		'/api/approvals/requests' +
			query({
				scope: filter.scope ?? '',
				status: filter.status ?? '',
				sort: filter.sort ?? '',
				direction: filter.direction ?? '',
				limit: filter.limit === undefined ? '' : String(filter.limit),
				cursor: filter.cursor ?? '',
			}),
	);
	return { items: page.items, nextCursor: page.page.nextCursor };
}

export async function loadPendingCount(): Promise<number> {
	return (
		await get<{ readonly pending: number }>('/api/approvals/pending-count')
	).pending;
}

export async function loadRequest(id: string): Promise<ApprovalRequestView> {
	return get<ApprovalRequestView>(
		'/api/approvals/requests/' + encodeURIComponent(id),
	);
}

async function decision(
	path: string,
	id: string,
	comment: string,
	csrfToken: string,
): Promise<ApprovalRequestView> {
	return post<ApprovalRequestView>(
		path,
		comment === '' ? { id } : { id, comment },
		csrfToken,
	);
}

export async function approveRequest(
	id: string,
	comment: string,
	csrfToken: string,
): Promise<ApprovalRequestView> {
	return decision('/api/approvals/requests/approve', id, comment, csrfToken);
}

export async function rejectRequest(
	id: string,
	comment: string,
	csrfToken: string,
): Promise<ApprovalRequestView> {
	return decision('/api/approvals/requests/reject', id, comment, csrfToken);
}

export type BulkDecision = 'approve' | 'reject';

export async function decideRequests(
	ids: readonly string[],
	decision: BulkDecision,
	comment: string,
	csrfToken: string,
): Promise<readonly ApprovalDecideOutcome[]> {
	return (
		await post<{ readonly outcomes: readonly ApprovalDecideOutcome[] }>(
			'/api/approvals/decide-many',
			comment === '' ? { ids, decision } : { ids, decision, comment },
			csrfToken,
		)
	).outcomes;
}

export async function cancelRequest(
	id: string,
	csrfToken: string,
): Promise<ApprovalRequestView> {
	return post<ApprovalRequestView>(
		'/api/approvals/requests/cancel',
		{ id },
		csrfToken,
	);
}
