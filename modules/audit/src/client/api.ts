import { t } from '@flowdular/client/i18n';
import type {
	AuditDataClass,
	AuditExportRun,
	AuditLegalHold,
	AuditRegistryModule,
	AuditSweepRun,
	ExportStatus,
	HoldScopeKind,
	HoldStatus,
	RetentionMode,
	SweepStatus,
} from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
	};
}

/** A failed request with the server's stable code, so a screen can translate it. */
export class AuditApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'AuditApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * The server message is English and written for an operator. A code this module
 * knows becomes translated copy; anything else keeps the server's own sentence
 * rather than hiding what went wrong behind a generic line.
 */
export function auditErrorMessage(error: unknown, fallbackKey: string): string {
	if (error instanceof AuditApiError) {
		const key = 'audit.error.code.' + error.code;
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
		throw new AuditApiError(
			response.status,
			value.error?.code ?? 'REQUEST_FAILED',
			value.error?.message ?? t('audit.error.request'),
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

export async function loadRegistry(): Promise<readonly AuditRegistryModule[]> {
	return (
		await get<{ readonly modules: readonly AuditRegistryModule[] }>(
			'/api/audit/data-classes',
		)
	).modules;
}

export async function setRetention(
	input: {
		readonly classId: string;
		readonly mode: RetentionMode;
		readonly days: number | null;
	},
	csrfToken: string,
): Promise<AuditDataClass> {
	return (
		await post<{ readonly dataClass: AuditDataClass }>(
			'/api/audit/data-classes/set-retention',
			input,
			csrfToken,
		)
	).dataClass;
}

export async function loadSweeps(
	status: SweepStatus | '' = '',
): Promise<readonly AuditSweepRun[]> {
	return (
		await get<{ readonly sweeps: readonly AuditSweepRun[] }>(
			'/api/audit/sweeps' + query({ status }),
		)
	).sweeps;
}

export async function loadExports(
	status: ExportStatus | '' = '',
): Promise<readonly AuditExportRun[]> {
	return (
		await get<{ readonly exports: readonly AuditExportRun[] }>(
			'/api/audit/exports' + query({ status }),
		)
	).exports;
}

export async function loadHolds(
	status: HoldStatus | '' = '',
): Promise<readonly AuditLegalHold[]> {
	return (
		await get<{ readonly holds: readonly AuditLegalHold[] }>(
			'/api/audit/holds' + query({ status }),
		)
	).holds;
}

export async function placeHold(
	input: {
		readonly scopeKind: HoldScopeKind;
		readonly accountId: string | null;
		readonly classId: string | null;
		readonly fromAt: number | null;
		readonly toAt: number | null;
		readonly reason: string;
	},
	csrfToken: string,
): Promise<AuditLegalHold> {
	return (
		await post<{ readonly hold: AuditLegalHold }>(
			'/api/audit/holds/place',
			input,
			csrfToken,
		)
	).hold;
}

export async function liftHold(
	input: { readonly id: string; readonly reason: string },
	csrfToken: string,
): Promise<AuditLegalHold> {
	return (
		await post<{ readonly hold: AuditLegalHold }>(
			'/api/audit/holds/lift',
			input,
			csrfToken,
		)
	).hold;
}
