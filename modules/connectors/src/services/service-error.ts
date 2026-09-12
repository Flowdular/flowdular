export class ConnectorsServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'ConnectorsServiceError';
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
		throw new ConnectorsServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} characters.`,
		);
	}
	if (/[\u0000-\u001f\u007f]/.test(normalized)) {
		throw new ConnectorsServiceError(
			'INVALID_INPUT',
			`${field} contains an unsupported character.`,
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
		throw new ConnectorsServiceError(
			'INVALID_INPUT',
			`${field} must be one of: ${allowed.join(', ')}.`,
		);
	}
	return value as T;
}
