export class SearchServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'SearchServiceError';
	}
}

export function bounded(
	value: unknown,
	field: string,
	minimum: number,
	maximum: number,
): string {
	if (typeof value !== 'string') {
		throw new SearchServiceError('INVALID_INPUT', `${field} must be text.`);
	}
	const normalized = value.trim();
	if (normalized.length < minimum || normalized.length > maximum) {
		throw new SearchServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} characters.`,
		);
	}
	if (normalized.includes('\u0000')) {
		throw new SearchServiceError(
			'INVALID_INPUT',
			`${field} contains an unsupported character.`,
		);
	}
	return normalized;
}
