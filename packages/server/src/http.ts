export class HttpProblem extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = 'HttpProblem';
	}
}

export function jsonResponse(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: { 'cache-control': 'no-store' },
	});
}

export function problemResponse(
	error: unknown,
	fallbackMessage = 'The operation failed.',
): Response {
	if (error instanceof HttpProblem) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return jsonResponse(
		{ error: { code: 'INTERNAL_ERROR', message: fallbackMessage } },
		500,
	);
}

export async function readJsonObject(
	request: Request,
	maxBytes = 16_384,
): Promise<Record<string, unknown>> {
	if (
		!(request.headers.get('content-type') ?? '')
			.toLowerCase()
			.startsWith('application/json')
	) {
		throw new HttpProblem(
			'CONTENT_TYPE_REQUIRED',
			'Expected application/json.',
			415,
		);
	}
	const declaredLength = Number(request.headers.get('content-length') ?? 0);
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new HttpProblem(
			'PAYLOAD_TOO_LARGE',
			'The request body is too large.',
			413,
		);
	}
	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > maxBytes) {
		throw new HttpProblem(
			'PAYLOAD_TOO_LARGE',
			'The request body is too large.',
			413,
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		throw new HttpProblem(
			'INVALID_JSON',
			'The request body is not valid JSON.',
			400,
		);
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new HttpProblem('INVALID_INPUT', 'Expected a JSON object.', 400);
	}
	return value as Record<string, unknown>;
}

export function requiredString(
	value: Record<string, unknown>,
	key: string,
	options: { readonly min?: number; readonly max?: number } = {},
): string {
	const result = value[key];
	if (typeof result !== 'string') {
		throw new HttpProblem('INVALID_INPUT', `${key} must be a string.`, 400);
	}
	const normalized = result.trim();
	if (normalized.length < (options.min ?? 1)) {
		throw new HttpProblem('INVALID_INPUT', `${key} is too short.`, 400);
	}
	if (normalized.length > (options.max ?? Number.MAX_SAFE_INTEGER)) {
		throw new HttpProblem('INVALID_INPUT', `${key} is too long.`, 400);
	}
	return normalized;
}

export function optionalString(
	value: Record<string, unknown>,
	key: string,
	max: number,
): string | null {
	const result = value[key];
	if (result === undefined || result === null || result === '') return null;
	return requiredString(value, key, { max });
}

export function requiredInteger(
	value: Record<string, unknown>,
	key: string,
	options: { readonly min?: number; readonly max?: number } = {},
): number {
	const result = value[key];
	if (!Number.isSafeInteger(result)) {
		throw new HttpProblem('INVALID_INPUT', `${key} must be an integer.`, 400);
	}
	const integer = result as number;
	if (integer < (options.min ?? Number.MIN_SAFE_INTEGER)) {
		throw new HttpProblem('INVALID_INPUT', `${key} is too small.`, 400);
	}
	if (integer > (options.max ?? Number.MAX_SAFE_INTEGER)) {
		throw new HttpProblem('INVALID_INPUT', `${key} is too large.`, 400);
	}
	return integer;
}
