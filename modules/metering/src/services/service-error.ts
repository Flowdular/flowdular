export class MeteringServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'MeteringServiceError';
	}
}

export function bounded(
	value: string,
	field: string,
	minimum: number,
	maximum: number,
): string {
	const normalized = typeof value === 'string' ? value.trim() : '';
	if (normalized.length < minimum || normalized.length > maximum) {
		throw new MeteringServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} characters.`,
		);
	}
	if (normalized.includes('\u0000')) {
		throw new MeteringServiceError(
			'INVALID_INPUT',
			`${field} contains an unsupported character.`,
		);
	}
	return normalized;
}

export function wholeNumber(
	value: number,
	field: string,
	maximum: number,
): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
		throw new MeteringServiceError(
			'INVALID_INPUT',
			`${field} must be a whole number between 0 and ${maximum}.`,
		);
	}
	return value;
}
