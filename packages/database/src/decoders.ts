/**
 * Reads an integer column as the adapters hand it back: the embedded build
 * returns a number, the server driver returns int8 as text and a driver
 * configured for it returns a bigint. A fraction, an unsafe integer or a value
 * below `min` is a defect in the read, so it throws naming the field.
 */
export function integer(
	value: unknown,
	field: string,
	options?: { readonly min?: number },
): number {
	const normalized =
		typeof value === 'number' ||
		typeof value === 'bigint' ||
		typeof value === 'string'
			? Number(value)
			: Number.NaN;
	if (
		!Number.isSafeInteger(normalized) ||
		(options?.min !== undefined && normalized < options.min)
	) {
		throw new Error(`The database returned an invalid ${field}.`);
	}
	return normalized;
}
