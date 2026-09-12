export class NotificationsServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'NotificationsServiceError';
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
		throw new NotificationsServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} characters.`,
		);
	}
	if (normalized.includes('\u0000')) {
		throw new NotificationsServiceError(
			'INVALID_INPUT',
			`${field} contains an unsupported character.`,
		);
	}
	return normalized;
}

/**
 * A field that ends up on one line of a message or a header. A stored line
 * break would be refused there on every attempt, which is a deterministic
 * failure of the delivery rather than of this write, so it is refused here.
 */
export function singleLine(
	value: string,
	field: string,
	minimum: number,
	maximum: number,
): string {
	const normalized = bounded(value, field, minimum, maximum);
	if (normalized.includes('\r') || normalized.includes('\n')) {
		throw new NotificationsServiceError(
			'INVALID_INPUT',
			`${field} must be a single line.`,
		);
	}
	return normalized;
}

export function oneOf<T extends string>(
	value: string,
	field: string,
	allowed: readonly T[],
): T {
	if (!(allowed as readonly string[]).includes(value)) {
		throw new NotificationsServiceError(
			'INVALID_INPUT',
			`${field} must be one of: ${allowed.join(', ')}.`,
		);
	}
	return value as T;
}
