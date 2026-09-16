import { t } from '@flowdular/client/i18n';
import type {
	ResearchAdaptersOverview,
	ResearchAdapterTestResult,
	ResearchAttemptRecord,
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

async function answer<T>(response: Response): Promise<T> {
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

async function get<T>(path: string): Promise<T> {
	return answer<T>(
		await fetch(path, {
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		}),
	);
}

async function post<T>(
	path: string,
	csrfToken: string,
	body: unknown,
): Promise<T> {
	return answer<T>(
		await fetch(path, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
				'x-csrf-token': csrfToken,
			},
			credentials: 'same-origin',
			body: JSON.stringify(body),
		}),
	);
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

export type ResearchAttemptRow = Omit<ResearchAttemptRecord, 'tenantId'>;

export async function loadQueryAttempts(
	id: string,
): Promise<readonly ResearchAttemptRow[]> {
	return (
		await get<{ readonly attempts: readonly ResearchAttemptRow[] }>(
			`/api/research/queries/${encodeURIComponent(id)}/attempts`,
		)
	).attempts;
}

export async function loadAdapters(): Promise<ResearchAdaptersOverview> {
	return (
		await get<{ readonly adapters: ResearchAdaptersOverview }>(
			'/api/research/adapters',
		)
	).adapters;
}

export interface ResearchChainSettingsChange {
	readonly searchOrder?: readonly string[];
	readonly enabled?: Readonly<Record<string, boolean>>;
	readonly fetchOrder?: readonly string[];
	readonly fallback?: string;
	readonly fallbackOnEmpty?: boolean;
	readonly retryBackoffMs?: number;
	readonly circuitFailureThreshold?: number;
	readonly circuitCooldownMs?: number;
}

export async function saveChainSettings(
	csrfToken: string,
	change: ResearchChainSettingsChange,
): Promise<ResearchAdaptersOverview> {
	return (
		await post<{ readonly adapters: ResearchAdaptersOverview }>(
			'/api/research/settings',
			csrfToken,
			change,
		)
	).adapters;
}

export type ResearchCredentialInput =
	| { readonly kind: 'none' }
	| { readonly kind: 'bearer'; readonly token: string }
	| {
			readonly kind: 'basic';
			readonly username: string;
			readonly password: string;
	  };

export interface ResearchAdapterConfigurationInput {
	readonly adapter: string;
	readonly baseUrl?: string;
	/** Absent keeps the credential connectors.core already holds. */
	readonly credential?: ResearchCredentialInput;
	readonly maxAttempts?: number;
	readonly timeoutMs?: number;
	readonly connectorInstanceId?: string;
	readonly recordedFixturesPath?: string;
}

export async function configureAdapter(
	csrfToken: string,
	input: ResearchAdapterConfigurationInput,
): Promise<ResearchAdaptersOverview> {
	return (
		await post<{ readonly adapters: ResearchAdaptersOverview }>(
			'/api/research/adapters/configure',
			csrfToken,
			input,
		)
	).adapters;
}

export async function testAdapter(
	csrfToken: string,
	adapter: string,
	query: string,
): Promise<ResearchAdapterTestResult> {
	return (
		await post<{ readonly test: ResearchAdapterTestResult }>(
			'/api/research/adapters/test',
			csrfToken,
			{ adapter, query },
		)
	).test;
}
