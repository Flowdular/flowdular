/** Refusals of the administration API. The SCIM surface raises `ScimError`. */
export class DirectoryServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'DirectoryServiceError';
	}
}

/* A control character reaching a label or a role key would travel into a table
   cell, a log line and a SCIM response, so it is refused at the boundary. */
function printable(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		if (value.charCodeAt(index) < 0x20) return false;
	}
	return true;
}

export function bounded(
	value: string,
	field: string,
	minimum: number,
	maximum: number,
): string {
	const normalized = value.trim();
	if (normalized.length < minimum || normalized.length > maximum) {
		throw new DirectoryServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} characters.`,
		);
	}
	if (!printable(normalized)) {
		throw new DirectoryServiceError(
			'INVALID_INPUT',
			`${field} contains an unsupported character.`,
		);
	}
	return normalized;
}
