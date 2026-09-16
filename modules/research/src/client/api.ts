import { t } from '@flowdular/client/i18n';
import type {
	ResearchEvidenceDetail,
	ResearchQueryRecord,
} from '../domain/types.ts';
import type { EvidenceEntry } from '../domain/capability.ts';

interface ErrorEnvelope {
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
	};
}

/** A failed request with the server's stable code, so a screen can translate it. */
export class ResearchApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'ResearchApiError';
		this.status = status;
		this.code = code;
	}
}

export function researchErrorMessage(
	error: unknown,
	fallbackKey: string,
): string {
	if (error instanceof ResearchApiError) {
		const key = 'research.error.code.' + error.code;
		const translated = t(key);
		if (translated !== key) return translated;
		return error.message;
	}
	if (error instanceof Error && error.message !== '') return error.message;
	return t(fallbackKey);
}

async function get<T>(path: string): Promise<T> {
	const response = await fetch(path, {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	const value = (await response.json().catch(() => ({}))) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new ResearchApiError(
			response.status,
			value.error?.code ?? 'REQUEST_FAILED',
			value.error?.message ?? t('research.error.request'),
		);
	}
	return value;
}

export interface ResearchEvidenceRow extends EvidenceEntry {
	readonly createdBy: string | null;
}

export type ResearchQueryRow = Omit<ResearchQueryRecord, 'tenantId'>;

export interface ResearchPageAnswer<T> {
	readonly items: readonly T[];
	readonly page: { readonly nextCursor: string | null };
}

function pagePath(path: string, cursor: string | null): string {
	return cursor === null
		? path
		: `${path}?cursor=${encodeURIComponent(cursor)}`;
}

export function loadEvidence(
	cursor: string | null,
): Promise<ResearchPageAnswer<ResearchEvidenceRow>> {
	return get(pagePath('/api/research/evidence', cursor));
}

export function loadQueries(
	cursor: string | null,
): Promise<ResearchPageAnswer<ResearchQueryRow>> {
	return get(pagePath('/api/research/queries', cursor));
}

export async function loadEvidenceDetail(
	id: string,
): Promise<ResearchEvidenceDetail> {
	return (
		await get<{ readonly evidence: ResearchEvidenceDetail }>(
			`/api/research/evidence/${encodeURIComponent(id)}`,
		)
	).evidence;
}
