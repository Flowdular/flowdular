export interface ResearchFailureTraits {
	/** A timeout, a network failure, a 5xx, a 408 or a 429: worth another attempt. */
	readonly retryable?: boolean;
	/** The wait a provider asked for with Retry-After, before the chain's cap. */
	readonly retryAfterMs?: number | null;
	/** False when the failure is not the adapter's own, so it never opens a circuit. */
	readonly health?: boolean;
}

export class ResearchServiceError extends Error {
	readonly traits: ResearchFailureTraits;

	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
		traits: ResearchFailureTraits = {},
	) {
		super(message);
		this.name = 'ResearchServiceError';
		this.traits = traits;
	}
}
