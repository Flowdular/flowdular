import { t } from '@flowdular/client/i18n';
import type {
	ConnectorCall,
	ConnectorCallOutcome,
	ConnectorDefinition,
	ConnectorInstance,
} from '../domain/types.ts';
import type { TestCallReport } from './state.ts';

interface ErrorEnvelope {
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
	};
}

/** A failed request with the server's stable code, so a screen can translate it. */
export class ConnectorsApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'ConnectorsApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * The server message is English and written for an operator. A code this module
 * knows becomes translated copy; anything else keeps the server's own sentence
 * rather than hiding what went wrong behind a generic line.
 */
export function connectorsErrorMessage(
	error: unknown,
	fallbackKey: string,
): string {
	if (error instanceof ConnectorsApiError) {
		const key = 'connectors.error.code.' + error.code;
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
		throw new ConnectorsApiError(
			response.status,
			value.error?.code ?? 'REQUEST_FAILED',
			value.error?.message ?? t('connectors.error.request'),
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
				accept: 'application/json',
			},
			credentials: 'same-origin',
			body: JSON.stringify(body),
		}),
	);
}

export async function loadConnectorDefinitions(): Promise<
	readonly ConnectorDefinition[]
> {
	return (
		await get<{ readonly definitions: readonly ConnectorDefinition[] }>(
			'/api/connectors/definitions',
		)
	).definitions;
}

export async function loadConnectorInstances(): Promise<
	readonly ConnectorInstance[]
> {
	return (
		await get<{ readonly instances: readonly ConnectorInstance[] }>(
			'/api/connectors/instances',
		)
	).instances;
}

export async function loadConnectorCalls(filters: {
	readonly outcome?: ConnectorCallOutcome | '';
	readonly instanceId?: string;
}): Promise<readonly ConnectorCall[]> {
	const query = new URLSearchParams();
	if (filters.outcome) query.set('outcome', filters.outcome);
	if (filters.instanceId) query.set('instanceId', filters.instanceId);
	const suffix = query.toString();
	return (
		await get<{ readonly calls: readonly ConnectorCall[] }>(
			'/api/connectors/calls' + (suffix === '' ? '' : '?' + suffix),
		)
	).calls;
}

export interface ConnectorFormValue {
	readonly definitionKey: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly authKind: ConnectorInstance['authKind'];
	readonly allowedHosts: readonly string[];
	readonly credentials?: Record<string, unknown> | undefined;
}

export async function createConnectorInstance(
	value: ConnectorFormValue,
	csrfToken: string,
): Promise<ConnectorInstance> {
	return (
		await post<{ readonly instance: ConnectorInstance }>(
			'/api/connectors/instances',
			value,
			csrfToken,
		)
	).instance;
}

export async function updateConnectorInstance(
	id: string,
	value: ConnectorFormValue,
	csrfToken: string,
): Promise<ConnectorInstance> {
	return (
		await post<{ readonly instance: ConnectorInstance }>(
			'/api/connectors/instances/update',
			{
				id,
				name: value.name,
				baseUrl: value.baseUrl,
				allowedHosts: value.allowedHosts,
				...(value.credentials === undefined
					? {}
					: { credentials: value.credentials }),
			},
			csrfToken,
		)
	).instance;
}

export async function setConnectorConsent(
	id: string,
	consent: {
		readonly allowWorkflows: boolean;
		readonly allowAgents: boolean;
	},
	csrfToken: string,
): Promise<ConnectorInstance> {
	return (
		await post<{ readonly instance: ConnectorInstance }>(
			'/api/connectors/instances/consent',
			{ id, ...consent, confirmed: true },
			csrfToken,
		)
	).instance;
}

export async function runConnectorTestCall(
	id: string,
	operation: string,
	input: Record<string, unknown>,
	csrfToken: string,
): Promise<TestCallReport> {
	return (
		await post<{ readonly result: TestCallReport }>(
			'/api/connectors/instances/test-call',
			{ id, operation, input },
			csrfToken,
		)
	).result;
}

export async function enableConnectorInstance(
	id: string,
	csrfToken: string,
): Promise<ConnectorInstance> {
	return (
		await post<{ readonly instance: ConnectorInstance }>(
			'/api/connectors/instances/enable',
			{ id },
			csrfToken,
		)
	).instance;
}

export async function disableConnectorInstance(
	id: string,
	csrfToken: string,
): Promise<ConnectorInstance> {
	return (
		await post<{ readonly instance: ConnectorInstance }>(
			'/api/connectors/instances/disable',
			{ id },
			csrfToken,
		)
	).instance;
}

export async function deleteConnectorInstance(
	id: string,
	csrfToken: string,
): Promise<void> {
	await post<{ readonly deleted: boolean }>(
		'/api/connectors/instances/delete',
		{ id },
		csrfToken,
	);
}
