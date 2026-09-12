export class ReportsServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'ReportsServiceError';
	}
}

export function bounded(
	value: unknown,
	field: string,
	min: number,
	max: number,
): string {
	const normalized = typeof value === 'string' ? value.trim() : '';
	if (normalized.length < min || normalized.length > max) {
		throw new ReportsServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${min} and ${max} characters.`,
		);
	}
	return normalized;
}
