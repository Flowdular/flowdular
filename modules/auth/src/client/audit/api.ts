export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

/* The three trails are stored differently, so each source normalizes its rows
   into this one shape and the screen renders a single table. */
export interface AuditRow {
	readonly id: string;
	readonly occurredAt: number;
	readonly actor: string;
	readonly action: string;
	readonly subjectType: string;
	readonly subjectId: string;
	readonly metadata: Readonly<Record<string, unknown>>;
}

export type AuditSource = 'platform' | 'agents' | 'sandbox';

export interface AuditFetchResult {
	readonly rows: readonly AuditRow[];
	readonly nextCursor: string | null;
	/** Actions offered in the filter for this source. */
	readonly actions: readonly string[];
}

/* Chain integrity of a hash-chained trail; null for the platform trail, which
   is append-only but not chained. */
export interface AuditVerification {
	readonly verified: boolean;
	readonly brokenAt: string | null;
}

export interface AuditFilter {
	readonly action: string;
	readonly actor: string;
	readonly cursor: string | null;
}

interface PlatformEvent {
	readonly id: number;
	readonly actorLabel: string;
	readonly action: string;
	readonly subjectType: string;
	readonly subjectId: string;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly occurredAt: number;
}

interface ChainEvent {
	readonly id: string;
	readonly actorId: string;
	readonly action: string;
	readonly subjectType: string;
	readonly subjectId: string;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly occurredAt: number;
}

async function getJson<T>(path: string): Promise<T> {
	const response = await fetch(path, {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	const body = (await response.json()) as T & {
		readonly error?: { readonly message?: string };
	};
	if (!response.ok) {
		throw new ApiError(
			response.status,
			body.error?.message ?? t('auth.audit.error.load'),
		);
	}
	return body;
}

function query(params: Record<string, string | null>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value) search.set(key, value);
	}
	const rendered = search.toString();
	return rendered ? '?' + rendered : '';
}

function distinctActions(rows: readonly AuditRow[]): readonly string[] {
	return [...new Set(rows.map((row) => row.action))].sort();
}

async function fetchPlatform(filter: AuditFilter): Promise<AuditFetchResult> {
	const body = await getJson<{
		readonly events: readonly PlatformEvent[];
		readonly nextCursor: string | null;
		readonly actions: readonly string[];
	}>(
		'/api/auth/audit' +
			query({
				action: filter.action,
				actor: filter.actor,
				cursor: filter.cursor,
			}),
	);
	return {
		rows: body.events.map((event) => ({
			id: String(event.id),
			occurredAt: event.occurredAt,
			actor: event.actorLabel,
			action: event.action,
			subjectType: event.subjectType,
			subjectId: event.subjectId,
			metadata: event.metadata,
		})),
		nextCursor: body.nextCursor,
		actions: body.actions,
	};
}

async function fetchChain(
	path: string,
	filter: AuditFilter,
): Promise<AuditFetchResult> {
	const body = await getJson<{
		readonly events: readonly ChainEvent[];
		readonly nextCursor: string | null;
	}>(path + query({ cursor: filter.cursor }));
	const rows = body.events.map((event) => ({
		id: event.id,
		occurredAt: event.occurredAt,
		actor: event.actorId,
		action: event.action,
		subjectType: event.subjectType,
		subjectId: event.subjectId,
		metadata: event.metadata,
	}));
	return { rows, nextCursor: body.nextCursor, actions: distinctActions(rows) };
}

export function loadAuditSource(
	source: AuditSource,
	filter: AuditFilter,
): Promise<AuditFetchResult> {
	if (source === 'agents') return fetchChain('/api/agent-audit', filter);
	if (source === 'sandbox') return fetchChain('/api/sandbox/audit', filter);
	return fetchPlatform(filter);
}

/* The platform trail carries no hash chain, so it has nothing to verify. */
export function verifyAuditSource(
	source: AuditSource,
): Promise<AuditVerification | null> {
	if (source === 'agents') {
		return getJson<AuditVerification>('/api/agent-audit/verify');
	}
	if (source === 'sandbox') {
		return getJson<AuditVerification>('/api/sandbox/audit/verify');
	}
	return Promise.resolve(null);
}
import { t } from '@coreloom/client/i18n';
