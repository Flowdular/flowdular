import type { AuditEvent } from '../../domain/types.ts';

export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

export interface AuditPageResult {
	readonly events: readonly AuditEvent[];
	readonly nextCursor: string | null;
	readonly actions: readonly string[];
}

export interface AuditFilter {
	readonly action: string;
	readonly actor: string;
	readonly cursor: string | null;
}

export async function loadAudit(filter: AuditFilter): Promise<AuditPageResult> {
	const search = new URLSearchParams();
	if (filter.action) search.set('action', filter.action);
	if (filter.actor) search.set('actor', filter.actor);
	if (filter.cursor) search.set('cursor', filter.cursor);
	const query = search.toString();
	const response = await fetch('/api/auth/audit' + (query ? '?' + query : ''), {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	const body = (await response.json()) as AuditPageResult & {
		readonly error?: { readonly message?: string };
	};
	if (!response.ok) {
		throw new ApiError(
			response.status,
			body.error?.message ?? 'Could not load the audit trail.',
		);
	}
	return body;
}
