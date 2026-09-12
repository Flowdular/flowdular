import { cell, createStore } from 'segment-state';
import type { DocumentAttachment } from '../domain/attachments.ts';
import type { DocumentScan } from '../domain/types.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus =
	| 'idle'
	| 'loading'
	| 'submitting'
	| 'denied'
	| 'error';

export function createDocumentsClientState() {
	const store = createStore({
		documents: cell<readonly DocumentAttachment[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		/* The term the rows on screen were loaded with, so a typed one is known
		   to be pending and a cleared one still asks the server for a listing. */
		appliedQuery: '',
		ownerModuleFilter: '',
		scanFilter: cell<DocumentScan | ''>(''),
		/* Owner modules seen on any page loaded so far: the filter's options
		   cannot come from one page without disappearing as the reader walks. */
		ownerModulesSeen: cell<readonly string[]>([]),
		filtersOpen: false,
		uploaderOpen: false,
		/* Remounts the uploader so the native file input starts empty again. */
		formSession: 0,
		/* Null once the server stops handing one back: that is the last page. */
		nextCursor: cell<string | null>(null),
		confirmDeleteId: cell<string | null>(null),
	});
	return { store, state: store.state };
}

/**
 * Whether the typed term still has to reach the server. The search is a query
 * filter, so what is on screen is only right once a listing was loaded with
 * exactly this term; whitespace alone is not a term.
 */
export function searchPending(query: string, applied: string): boolean {
	return query.trim() !== applied;
}

/** Owner modules present in the loaded set, for the filter's option list. */
export function ownerModules(
	documents: readonly DocumentAttachment[],
): readonly string[] {
	return [...new Set(documents.map((document) => document.ownerModule))].sort();
}

/**
 * The rows a screen holds after a page arrives. Appending keeps what the reader
 * already walked; a new listing replaces it, so a changed filter can never mix
 * two result sets.
 */
export function mergeDocumentPage(
	held: readonly DocumentAttachment[],
	page: readonly DocumentAttachment[],
	append: boolean,
): readonly DocumentAttachment[] {
	return append ? [...held, ...page] : page;
}

/** The owner modules the filter offers once this page has been seen. */
export function mergeOwnerModules(
	seen: readonly string[],
	page: readonly DocumentAttachment[],
): readonly string[] {
	return [...new Set([...seen, ...ownerModules(page)])].sort();
}
