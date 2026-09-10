import { createHash } from 'node:crypto';

export interface TargetIdempotencyRequest {
	readonly key: string;
	readonly operationId: string;
	readonly inputDigest: string;
}

export interface TargetIdempotencyEntry {
	readonly operationId: string;
	readonly inputDigest: string;
	readonly resultJson: string;
	readonly resultDigest: string;
}

export class TargetIdempotencyConflictError extends Error {
	readonly code = 'CATALOG_IDEMPOTENCY_CONFLICT';

	constructor() {
		super(
			'The idempotency key is bound to another catalog operation or input.',
		);
		this.name = 'TargetIdempotencyConflictError';
	}
}

export class TargetIdempotencyCorruptionError extends Error {
	readonly code = 'CATALOG_IDEMPOTENCY_LEDGER_CORRUPT';

	constructor() {
		super('The catalog idempotency ledger contains an invalid result.');
		this.name = 'TargetIdempotencyCorruptionError';
	}
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		if (typeof value === 'number' && !Number.isFinite(value)) {
			throw new Error(
				'Canonical idempotency input must contain finite numbers.',
			);
		}
		const encoded = JSON.stringify(value);
		if (encoded === undefined) {
			throw new Error('Canonical idempotency input must be JSON serializable.');
		}
		return encoded;
	}
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.filter(([, entry]) => entry !== undefined)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
		.join(',')}}`;
}

export function canonicalDigest(value: unknown): string {
	return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}
