import type { ListPage, PageDirection, PageKey } from './repository.ts';
import { bounded, NotificationsServiceError, oneOf } from './service-error.ts';

/** Most rows one list request returns, and what a caller gets without asking. */
export const LIST_PAGE_LIMIT = 200;
export const LIST_PAGE_DEFAULT = 50;

const DIRECTIONS: readonly PageDirection[] = ['asc', 'desc'];

/** What a service accepts about a page; everything has a default. */
export interface ListPageInput<Key extends string | number> {
	readonly limit?: number | undefined;
	readonly direction?: PageDirection | undefined;
	readonly after?: PageKey<Key> | null | undefined;
}

export interface ListResult<Row, Key extends string | number> {
	readonly items: readonly Row[];
	readonly next: PageKey<Key> | null;
}

function invalid(message: string): NotificationsServiceError {
	return new NotificationsServiceError('INVALID_INPUT', message);
}

/** A time key of a page: a millisecond timestamp the ledger could hold. */
export function timeKey(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw invalid('The page key must be a timestamp.');
	}
	return value;
}

/** A text key of a page, bounded like the field it was read from. */
export function textKey(value: unknown, maximum: number): string {
	if (typeof value !== 'string') throw invalid('The page key must be text.');
	return bounded(value, 'page key', 1, maximum);
}

export function listPage<Key extends string | number>(
	input: ListPageInput<Key>,
	defaultDirection: PageDirection,
	key: (value: unknown) => Key,
): ListPage<Key> {
	const limit = input.limit ?? LIST_PAGE_DEFAULT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_PAGE_LIMIT) {
		throw invalid(`limit must be an integer between 1 and ${LIST_PAGE_LIMIT}.`);
	}
	const after = input.after ?? null;
	return {
		limit,
		direction: input.direction
			? oneOf(input.direction, 'direction', DIRECTIONS)
			: defaultDirection,
		after:
			after === null
				? null
				: { key: key(after.key), id: bounded(after.id, 'page id', 1, 128) },
	};
}
