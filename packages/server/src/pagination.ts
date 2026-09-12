import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpProblem, jsonResponse } from './http.ts';

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
/* A cursor travels in a query string and is never stored, so it stays small
   enough for a URL and for a log line that records one. */
export const MAX_CURSOR_LENGTH = 1024;
export const MAX_KEYSET_COLUMNS = 4;

const CURSOR_VERSION = 'c1';
const CURSOR_SECRET_BYTES = 32;
const CURSOR_CHARACTERS = /^[A-Za-z0-9._-]+$/;
const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface PageQuery {
	readonly limit: number;
	/** The opaque cursor as it arrived; `decodeCursor` reads it. */
	readonly cursor: string | null;
}

export interface PageQueryOptions {
	readonly maxLimit?: number;
	readonly defaultLimit?: number;
}

/**
 * The `limit` and `cursor` of a list request. Bad input is the caller's, so it
 * throws `HttpProblem` with status 400 for `problemResponse` to answer.
 */
export function readPageQuery(
	url: URL,
	options: PageQueryOptions = {},
): PageQuery {
	const maxLimit = options.maxLimit ?? MAX_PAGE_LIMIT;
	const defaultLimit =
		options.defaultLimit ?? Math.min(maxLimit, DEFAULT_PAGE_LIMIT);
	if (!Number.isSafeInteger(maxLimit) || maxLimit < 1) {
		throw new Error('A page maxLimit must be a positive integer.');
	}
	if (maxLimit > MAX_PAGE_LIMIT) {
		throw new Error(`A page maxLimit is at most ${MAX_PAGE_LIMIT}.`);
	}
	if (
		!Number.isSafeInteger(defaultLimit) ||
		defaultLimit < 1 ||
		defaultLimit > maxLimit
	) {
		throw new Error('A page defaultLimit must be between 1 and maxLimit.');
	}

	const requested = url.searchParams.get('limit');
	let limit = defaultLimit;
	if (requested !== null && requested.trim() !== '') {
		limit = Number(requested);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
			throw new HttpProblem(
				'INVALID_INPUT',
				`limit must be an integer between 1 and ${maxLimit}.`,
				400,
			);
		}
	}

	const cursor = url.searchParams.get('cursor');
	if (cursor === null || cursor === '') return { limit, cursor: null };
	if (cursor.length > MAX_CURSOR_LENGTH || !CURSOR_CHARACTERS.test(cursor)) {
		throw invalidCursor();
	}
	return { limit, cursor };
}

/**
 * The keyset of the last row of a page, signed so a caller cannot move the
 * page boundary onto a row the query would otherwise have excluded.
 */
export function encodeCursor(
	payload: Record<string, string | number>,
	secret: Uint8Array,
): string {
	assertCursorSecret(secret);
	for (const [key, value] of Object.entries(payload)) {
		if (typeof value === 'number' && !Number.isFinite(value)) {
			throw new Error(`Cursor field ${key} must be a finite number.`);
		}
	}
	const body = Buffer.from(JSON.stringify(payload), 'utf8').toString(
		'base64url',
	);
	const signed = `${CURSOR_VERSION}.${body}`;
	const cursor = `${signed}.${signature(signed, secret).toString('base64url')}`;
	if (cursor.length > MAX_CURSOR_LENGTH) {
		throw new Error(
			`A page cursor is at most ${MAX_CURSOR_LENGTH} characters; page by keyset, not by state.`,
		);
	}
	return cursor;
}

/** Throws `HttpProblem` `CURSOR_INVALID` (400) for anything this server did not sign. */
export function decodeCursor(
	cursor: string,
	secret: Uint8Array,
): Record<string, string | number> {
	assertCursorSecret(secret);
	if (
		typeof cursor !== 'string' ||
		cursor.length === 0 ||
		cursor.length > MAX_CURSOR_LENGTH
	) {
		throw invalidCursor();
	}
	const parts = cursor.split('.');
	const version = parts[0];
	const body = parts[1];
	const suppliedSignature = parts[2];
	if (
		parts.length !== 3 ||
		version !== CURSOR_VERSION ||
		!body ||
		!suppliedSignature
	) {
		throw invalidCursor();
	}
	/* base64url decoding drops characters it cannot read, so the signature is
	   compared by length and in constant time rather than by its text. */
	const expected = signature(`${version}.${body}`, secret);
	const supplied = Buffer.from(suppliedSignature, 'base64url');
	if (
		supplied.length !== expected.length ||
		!timingSafeEqual(supplied, expected)
	) {
		throw invalidCursor();
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
	} catch {
		throw invalidCursor();
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw invalidCursor();
	}
	for (const field of Object.values(value as Record<string, unknown>)) {
		if (typeof field === 'string') continue;
		if (typeof field === 'number' && Number.isFinite(field)) continue;
		throw invalidCursor();
	}
	return value as Record<string, string | number>;
}

export interface PageResult<T> {
	readonly items: readonly T[];
	readonly limit: number;
	/** Null on the last page: a client stops when the cursor stops. */
	readonly nextCursor: string | null;
	/** Only where the count is cheap; a count over every row of a tenant is not. */
	readonly total?: number;
}

export function pageResponse<T>(page: PageResult<T>): Response {
	return jsonResponse({
		items: page.items,
		page: {
			nextCursor: page.nextCursor,
			limit: page.limit,
			...(page.total === undefined ? {} : { total: page.total }),
		},
	});
}

export interface KeysetOptions {
	/** The ORDER BY direction of every keyset column. Defaults to `desc`. */
	readonly direction?: 'asc' | 'desc';
	/** How many parameters the statement already binds before this predicate. */
	readonly parameterOffset?: number;
}

export interface KeysetPredicate {
	readonly text: string;
	readonly parameters: readonly (string | number)[];
}

/**
 * The row-order predicate of a keyset page, for `(created_at, id)` and any
 * other unique ordering: `(created_at < $1 OR (created_at = $1 AND id < $2))`.
 * Column names are interpolated, so they are checked as plain identifiers and
 * must never come from a request; the cursor values are bound.
 */
export function keysetWhere(
	columns: readonly string[],
	cursorValues: readonly (string | number)[],
	options: KeysetOptions = {},
): KeysetPredicate {
	if (columns.length === 0 || columns.length > MAX_KEYSET_COLUMNS) {
		throw new Error(
			`A keyset orders by 1 to ${MAX_KEYSET_COLUMNS} columns, ending in a unique one.`,
		);
	}
	if (columns.length !== cursorValues.length) {
		throw new Error('A keyset needs one cursor value per column.');
	}
	const offset = options.parameterOffset ?? 0;
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new Error('A keyset parameterOffset must be a whole number.');
	}
	for (const column of columns) {
		if (!SQL_IDENTIFIER.test(column)) {
			throw new Error(`Keyset column ${column} is not a plain identifier.`);
		}
	}
	const comparison = (options.direction ?? 'desc') === 'desc' ? '<' : '>';
	const terms: string[] = [];
	for (let index = 0; index < columns.length; index += 1) {
		const conditions = columns
			.slice(0, index)
			.map((column, position) => `${column} = $${offset + position + 1}`);
		conditions.push(`${columns[index]} ${comparison} $${offset + index + 1}`);
		terms.push(
			conditions.length === 1
				? conditions[0]!
				: `(${conditions.join(' AND ')})`,
		);
	}
	return { text: `(${terms.join(' OR ')})`, parameters: [...cursorValues] };
}

function signature(body: string, secret: Uint8Array): Buffer {
	return createHmac('sha256', secret).update(body).digest();
}

function assertCursorSecret(secret: Uint8Array): void {
	if (secret.length < CURSOR_SECRET_BYTES) {
		throw new Error(`Cursor signing requires ${CURSOR_SECRET_BYTES} bytes.`);
	}
}

/* One answer for a cursor this server did not sign, one it no longer accepts
   and one a caller edited: a client that meets it restarts from the first page. */
function invalidCursor(): HttpProblem {
	return new HttpProblem(
		'CURSOR_INVALID',
		'The page cursor is not valid.',
		400,
	);
}
