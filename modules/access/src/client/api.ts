import { t } from '@flowdular/client/i18n';
import type {
	AccessAttestation,
	AccessChange,
	AccessReview,
	AccessWindow,
} from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
	};
}

/** A failed request with the server's stable code, so a screen can translate it. */
export class AccessApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'AccessApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * The server message is English and written for an operator. A code this
 * module knows becomes translated copy; anything else keeps the server's own
 * sentence rather than hiding what went wrong behind a generic line.
 */
export function accessErrorMessage(
	error: unknown,
	fallbackKey: string,
): string {
	if (error instanceof AccessApiError) {
		const key = 'access.error.code.' + error.code;
		const translated = t(key);
		if (translated !== key) return translated;
		return error.message;
	}
	if (error instanceof Error && error.message !== '') return error.message;
	return t(fallbackKey);
}

async function readBody<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new AccessApiError(
			response.status,
			value.error?.code ?? 'REQUEST_FAILED',
			value.error?.message ?? t('access.error.request'),
		);
	}
	return value;
}

async function get<T>(path: string): Promise<T> {
	return readBody<T>(
		await fetch(path, {
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		}),
	);
}

export async function loadReview(): Promise<AccessReview> {
	return (await get<{ readonly review: AccessReview }>('/api/access/review'))
		.review;
}

export interface ChangesPage {
	readonly items: readonly AccessChange[];
	readonly page: { readonly nextCursor: string | null };
	readonly window: AccessWindow;
	readonly source: string;
}

export interface ChangesQuery {
	readonly from: string;
	readonly to: string;
	readonly cursor?: string | null;
}

export async function loadChanges(
	kind: 'diff' | 'activity',
	query: ChangesQuery,
): Promise<ChangesPage> {
	const parameters = new URLSearchParams({ from: query.from, to: query.to });
	if (query.cursor) parameters.set('cursor', query.cursor);
	return get<ChangesPage>(`/api/access/${kind}?${parameters.toString()}`);
}

export interface AttestationsPage {
	readonly items: readonly AccessAttestation[];
	readonly page: { readonly nextCursor: string | null };
}

export async function loadAttestations(
	cursor: string | null,
): Promise<AttestationsPage> {
	const parameters = new URLSearchParams();
	if (cursor) parameters.set('cursor', cursor);
	const query = parameters.toString();
	return get<AttestationsPage>(
		'/api/access/attestations' + (query === '' ? '' : `?${query}`),
	);
}

export async function recordAttestation(
	input: {
		readonly from: string;
		readonly to: string;
		readonly note: string | null;
	},
	csrfToken: string,
): Promise<AccessAttestation> {
	const response = await fetch('/api/access/attest', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	return (await readBody<{ readonly attestation: AccessAttestation }>(response))
		.attestation;
}
