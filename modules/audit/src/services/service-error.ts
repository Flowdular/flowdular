export class AuditServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'AuditServiceError';
	}
}

export function bounded(
	value: string,
	field: string,
	minimum: number,
	maximum: number,
): string {
	const normalized = value.trim();
	if (normalized.length < minimum || normalized.length > maximum) {
		throw new AuditServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} characters.`,
		);
	}
	if (normalized.includes('\u0000')) {
		throw new AuditServiceError(
			'INVALID_INPUT',
			`${field} contains an unsupported character.`,
		);
	}
	return normalized;
}

export function boundedInteger(
	value: number,
	field: string,
	minimum: number,
	maximum: number,
): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new AuditServiceError(
			'INVALID_INPUT',
			`${field} must be a whole number between ${minimum} and ${maximum}.`,
		);
	}
	return value;
}

export function oneOf<T extends string>(
	value: string,
	field: string,
	allowed: readonly T[],
): T {
	if (!(allowed as readonly string[]).includes(value)) {
		throw new AuditServiceError(
			'INVALID_INPUT',
			`${field} must be one of: ${allowed.join(', ')}.`,
		);
	}
	return value as T;
}
