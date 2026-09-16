import { t } from '@flowdular/client/i18n';
import type { AdapterMappingRule } from '../domain/registry.ts';
import type {
	AdapterBinding,
	AdapterRunRow,
	AdapterRunView,
} from '../domain/types.ts';
import type {
	AdapterView,
	DryRunResult,
} from '../services/adapters-service.ts';

interface ErrorEnvelope {
	readonly error?: { readonly code?: string; readonly message?: string };
}

/** A failed request with the server's stable code, so a screen can translate it. */
export class AdaptersApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'AdaptersApiError';
	}
}

/** The run with its last run already reduced to what the API answers. */
export type AdapterListItem = Omit<AdapterView, 'lastRun'> & {
	readonly lastRun: AdapterRunView | null;
};

export interface ConnectorInstanceOption {
	readonly id: string;
	readonly name: string;
	readonly definitionKey: string;
	readonly status: string;
	readonly allowWorkflows: boolean;
}

export interface Page<T> {
	readonly items: readonly T[];
	readonly page: { readonly nextCursor: string | null };
}

export function adaptersErrorMessage(
	error: unknown,
	fallbackKey: string,
): string {
	if (error instanceof AdaptersApiError) {
		const key = 'adapters.error.code.' + error.code;
		const translated = t(key);
		return translated === key ? error.message : translated;
	}
	if (error instanceof Error && error.message !== '') return error.message;
	return t(fallbackKey);
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json().catch(() => ({}))) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new AdaptersApiError(
			response.status,
			value.error?.code ?? 'REQUEST_FAILED',
			value.error?.message ?? t('adapters.error.request'),
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

export async function loadAdapters(): Promise<readonly AdapterListItem[]> {
	return (await get<{ adapters: readonly AdapterListItem[] }>('/api/adapters'))
		.adapters;
}

/**
 * The instances an owner can bind, read from connectors.core's own list. A
 * workspace without connectors, or a reader it refuses, gets none, and the
 * drawer then offers the recorded fixture alone.
 */
export async function loadInstances(
	definitionKey: string,
): Promise<readonly ConnectorInstanceOption[]> {
	try {
		const page = await get<Page<ConnectorInstanceOption>>(
			'/api/connectors/instances' +
				query({ definition: definitionKey, limit: '100' }),
		);
		return page.items;
	} catch (error) {
		if (
			error instanceof AdaptersApiError &&
			(error.status === 403 || error.status === 404)
		) {
			return [];
		}
		throw error;
	}
}

export interface BindingInput {
	readonly adapterId: string;
	readonly instanceId: string | null;
	readonly enabled: boolean;
	readonly mapping: readonly AdapterMappingRule[] | null;
	readonly schedule: string | null;
}

export async function saveBinding(
	input: BindingInput,
	csrfToken: string,
): Promise<Omit<AdapterBinding, 'tenantId'>> {
	return (
		await post<{ binding: Omit<AdapterBinding, 'tenantId'> }>(
			'/api/adapters/bind',
			input,
			csrfToken,
		)
	).binding;
}

export async function dryRun(
	adapterId: string,
	mapping: readonly AdapterMappingRule[] | null,
	csrfToken: string,
): Promise<DryRunResult> {
	return (
		await post<{ dryRun: DryRunResult }>(
			'/api/adapters/dry-run',
			{ adapterId, mapping },
			csrfToken,
		)
	).dryRun;
}

export async function startRun(
	adapterId: string,
	csrfToken: string,
): Promise<AdapterRunView> {
	return (
		await post<{ run: AdapterRunView }>(
			'/api/adapters/runs/start',
			{ adapterId },
			csrfToken,
		)
	).run;
}

export async function resumeRun(
	runId: string,
	csrfToken: string,
): Promise<AdapterRunView> {
	return (
		await post<{ run: AdapterRunView }>(
			'/api/adapters/runs/resume',
			{ runId },
			csrfToken,
		)
	).run;
}

export async function cancelRun(
	runId: string,
	csrfToken: string,
): Promise<AdapterRunView> {
	return (
		await post<{ run: AdapterRunView }>(
			'/api/adapters/runs/cancel',
			{ runId },
			csrfToken,
		)
	).run;
}

export async function loadRuns(
	adapterId: string,
	cursor: string | null = null,
): Promise<Page<AdapterRunView>> {
	return get<Page<AdapterRunView>>(
		'/api/adapters/runs' + query({ adapterId, cursor: cursor ?? '' }),
	);
}

export async function loadRunRows(
	runId: string,
	cursor: string | null = null,
): Promise<Page<AdapterRunRow>> {
	return get<Page<AdapterRunRow>>(
		`/api/adapters/runs/${encodeURIComponent(runId)}/rows` +
			query({ cursor: cursor ?? '' }),
	);
}
