import { t } from '@flowdular/client/i18n';
import type { ImportMode } from '../domain/ports.ts';
import { IMPORT_CSV_CONTENT_TYPE } from '../domain/types.ts';
import type {
	ImportJobView,
	ImportJobRow,
	ImportJobStatus,
	ImportMapping,
} from '../domain/types.ts';
import type { ImportTargetView } from '../services/import-service.ts';

interface ErrorEnvelope {
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
	};
}

/** A failed request with the server's stable code, so a screen can translate it. */
export class ImportApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'ImportApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * The server message is English and written for an operator. A code this module
 * knows becomes translated copy; anything else keeps the server's own sentence
 * rather than hiding what went wrong behind a generic line.
 */
export function importErrorMessage(
	error: unknown,
	fallbackKey: string,
): string {
	if (error instanceof ImportApiError) {
		const key = 'import.error.code.' + error.code;
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
		throw new ImportApiError(
			response.status,
			value.error?.code ?? 'REQUEST_FAILED',
			value.error?.message ?? t('import.error.request'),
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

interface Page<T> {
	readonly items: readonly T[];
	readonly page: { readonly nextCursor: string | null };
}

export async function loadTargets(): Promise<readonly ImportTargetView[]> {
	return (
		await get<{ targets: readonly ImportTargetView[] }>('/api/import/targets')
	).targets;
}

export interface JobFilter {
	readonly status?: ImportJobStatus | '';
	readonly target?: string;
	readonly cursor?: string | null;
}

function query(entries: Readonly<Record<string, string>>): string {
	const parameters = new URLSearchParams();
	for (const [key, value] of Object.entries(entries)) {
		if (value !== '') parameters.set(key, value);
	}
	const text = parameters.toString();
	return text === '' ? '' : '?' + text;
}

export async function loadJobs(
	filter: JobFilter = {},
): Promise<Page<ImportJobView>> {
	return get<Page<ImportJobView>>(
		'/api/import/jobs' +
			query({
				status: filter.status ?? '',
				target: filter.target ?? '',
				cursor: filter.cursor ?? '',
			}),
	);
}

export async function loadJob(id: string): Promise<ImportJobView> {
	return (
		await get<{ job: ImportJobView }>(
			`/api/import/jobs/${encodeURIComponent(id)}`,
		)
	).job;
}

export async function loadJobRows(
	id: string,
	cursor: string | null = null,
): Promise<Page<ImportJobRow>> {
	return get<Page<ImportJobRow>>(
		`/api/import/jobs/${encodeURIComponent(id)}/rows` +
			query({ cursor: cursor ?? '' }),
	);
}

export async function loadMapping(
	target: string,
): Promise<ImportMapping | null> {
	return (
		await get<{ mapping: ImportMapping | null }>(
			'/api/import/mappings' + query({ target }),
		)
	).mapping;
}

export async function saveMapping(
	target: string,
	columns: Readonly<Record<string, string>>,
	csrfToken: string,
): Promise<ImportMapping> {
	return (
		await post<{ mapping: ImportMapping }>(
			'/api/import/mappings/save',
			{ target, columns },
			csrfToken,
		)
	).mapping;
}

export interface StartImportRequest {
	readonly target: string;
	readonly documentId: string;
	readonly documentRef: string;
	readonly mode: ImportMode;
	readonly dryRun: boolean;
	readonly columns: Readonly<Record<string, string>>;
}

export async function startImport(
	input: StartImportRequest,
	csrfToken: string,
): Promise<ImportJobView> {
	return (
		await post<{ job: ImportJobView }>(
			'/api/import/jobs/start',
			input,
			csrfToken,
		)
	).job;
}

export async function continueImport(
	id: string,
	validOnly: boolean,
	csrfToken: string,
): Promise<ImportJobView> {
	return (
		await post<{ job: ImportJobView }>(
			'/api/import/jobs/continue',
			{ id, validOnly },
			csrfToken,
		)
	).job;
}

export async function cancelImport(
	id: string,
	csrfToken: string,
): Promise<ImportJobView> {
	return (
		await post<{ job: ImportJobView }>(
			'/api/import/jobs/cancel',
			{ id },
			csrfToken,
		)
	).job;
}

/**
 * The CSV enters through documents.core, where the session, the CSRF proof, the
 * workspace quota and the storage limits are applied. import.core stores no
 * bytes of its own, so this is the only upload path.
 */
export async function uploadSourceCsv(
	file: File,
	documentRef: string,
	csrfToken: string,
): Promise<{ readonly id: string }> {
	const response = await fetch('/api/documents/upload', {
		method: 'POST',
		headers: {
			'content-type': IMPORT_CSV_CONTENT_TYPE,
			'x-csrf-token': csrfToken,
			'x-document-filename': encodeURIComponent(file.name),
			'x-document-owner-module': encodeURIComponent('import.core'),
			'x-document-record-ref': encodeURIComponent(documentRef),
		},
		credentials: 'same-origin',
		body: file,
	});
	return (await payload<{ document: { id: string } }>(response)).document;
}
