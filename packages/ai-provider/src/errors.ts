import { APICallError } from 'ai';

export class AiProviderError extends Error {
	constructor(
		readonly code: string,
		message: string,
		/* What the provider itself reported, redacted and kept server-side for
		   diagnostics. It never reaches a client response. */
		readonly detail: string | null = null,
	) {
		super(message);
		this.name = 'AiProviderError';
	}
}

/* Provider messages can echo the credential that was sent. Nothing derived
   from one is logged before this pass. */
export function redactSecrets(value: string): string {
	return value
		.replace(/\b(?:sk|rk|pk|api)[-_][A-Za-z0-9_-]{6,}/gi, '[redacted]')
		.replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]');
}

function providerStatus(error: unknown): number | null {
	return APICallError.isInstance(error) ? (error.statusCode ?? null) : null;
}

function providerDetail(error: unknown): string | null {
	if (!(error instanceof Error) || !error.message) return null;
	return redactSecrets(error.message).slice(0, 300);
}

/* Provider failures reach users and audit logs. They are classified into
   stable codes and never carry response bodies, prompts, or credentials.
   HTTP status decides the code when the SDK reports one: provider messages
   are prose and change without notice. */
export function classifyProviderFailure(error: unknown): AiProviderError {
	if (error instanceof AiProviderError) return error;
	const name = error instanceof Error ? error.name.toLowerCase() : '';
	const value = String(error).toLowerCase();
	const status = providerStatus(error);
	const detail = providerDetail(error);
	if (
		name.includes('abort') ||
		value.includes('timeout') ||
		status === 408 ||
		status === 504
	) {
		return new AiProviderError(
			'PROVIDER_TIMEOUT',
			'The provider did not respond within the configured timeout.',
			detail,
		);
	}
	if (
		status === 401 ||
		value.includes('401') ||
		value.includes('authentication')
	) {
		return new AiProviderError(
			'PROVIDER_AUTHENTICATION_FAILED',
			'The provider rejected the configured credential.',
			detail,
		);
	}
	if (status === 403 || value.includes('403') || value.includes('permission')) {
		return new AiProviderError(
			'PROVIDER_PERMISSION_DENIED',
			'The credential cannot access the selected model.',
			detail,
		);
	}
	if (
		status === 404 ||
		value.includes('404') ||
		value.includes('model not found')
	) {
		return new AiProviderError(
			'PROVIDER_MODEL_NOT_FOUND',
			'The selected model or deployment was not found.',
			detail,
		);
	}
	if (status === 429 || value.includes('429') || value.includes('rate limit')) {
		return new AiProviderError(
			'PROVIDER_RATE_LIMITED',
			'The provider rate limit prevented the request.',
			detail,
		);
	}
	if (status !== null && status >= 400 && status < 500) {
		return new AiProviderError(
			'PROVIDER_REQUEST_REJECTED',
			'The provider rejected the request. Inspect server diagnostics for the reported reason.',
			detail,
		);
	}
	if (status !== null && status >= 500) {
		return new AiProviderError(
			'PROVIDER_UNAVAILABLE',
			'The provider reported a server-side failure.',
			detail,
		);
	}
	return new AiProviderError(
		'PROVIDER_REQUEST_FAILED',
		'The provider request failed. Inspect server diagnostics using the request identifier.',
		detail,
	);
}
