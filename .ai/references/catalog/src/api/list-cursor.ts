import { createHash } from 'node:crypto';
import { decodeCursor, encodeCursor, HttpProblem } from '@flowdular/sdk/server';
import type {
	CatalogItemKind,
	CatalogItemStatus,
	CatalogListSort,
} from '../domain/types.ts';
import type { CatalogPageKeyset } from '../services/repository.ts';

/** The listing a cursor belongs to: its order and its filters. */
export interface CatalogListQuery {
	readonly sort: CatalogListSort;
	readonly direction: 'asc' | 'desc';
	readonly kind: CatalogItemKind | null;
	readonly status: CatalogItemStatus | null;
	readonly search: string;
}

function cursorInvalid(): HttpProblem {
	return new HttpProblem(
		'CURSOR_INVALID',
		'The page cursor is not valid.',
		400,
	);
}

/* The filters travel as a digest so a long term cannot push the signed cursor
   past its length bound. */
function filtersDigest(query: CatalogListQuery): string {
	return createHash('sha256')
		.update(
			JSON.stringify([query.kind ?? '', query.status ?? '', query.search]),
		)
		.digest('hex')
		.slice(0, 32);
}

/* The cursor names the position and the listing it belongs to: the workspace,
   the sort, the direction and the filters. A cursor presented with any of them
   changed would splice two listings, so it is refused rather than reused. */
function cursorPayload(
	tenantId: string,
	query: CatalogListQuery,
	keyset: CatalogPageKeyset,
): Record<string, string> {
	return {
		t: tenantId,
		s: query.sort,
		d: query.direction,
		f: filtersDigest(query),
		v: keyset.sortValue,
		id: keyset.id,
	};
}

export function encodeListCursor(
	secret: Uint8Array,
	tenantId: string,
	query: CatalogListQuery,
	keyset: CatalogPageKeyset,
): string {
	return encodeCursor(cursorPayload(tenantId, query, keyset), secret);
}

/** Throws `HttpProblem` `CURSOR_INVALID` (400) for a cursor of another listing. */
export function decodeListCursor(
	secret: Uint8Array,
	cursor: string,
	tenantId: string,
	query: CatalogListQuery,
): CatalogPageKeyset {
	const payload = decodeCursor(cursor, secret);
	const expected = cursorPayload(tenantId, query, { sortValue: '', id: '' });
	for (const key of ['t', 's', 'd', 'f'] as const) {
		if (payload[key] !== expected[key]) throw cursorInvalid();
	}
	const sortValue = payload.v;
	const id = payload.id;
	if (typeof sortValue !== 'string' || typeof id !== 'string') {
		throw cursorInvalid();
	}
	return { sortValue, id };
}
