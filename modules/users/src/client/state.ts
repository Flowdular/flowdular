import type { TenantMember, TenantMemberSort } from '@flowdular/module-auth';
import { t } from '@flowdular/client/i18n';
import type { TableSort } from '@flowdular/ui';
import { cell, createStore } from 'segment-state';
import type {
	MemberBulkOutcome,
	UsersContext,
} from '../services/users-service.ts';
import { ApiError, type MemberListPage } from './api.ts';

export type UsersStatus =
	| 'idle'
	| 'loading'
	| 'submitting'
	| 'denied'
	| 'error';

export type MemberStatusFilter = '' | 'active' | 'disabled';

export const DEFAULT_MEMBER_SORTING: readonly TableSort[] = [
	{ key: 'displayName', desc: false },
];

/**
 * The cursor that opened each page the reader has visited: page 0 has none,
 * and page n holds the cursor page n - 1 answered. Going back reuses the stored
 * cursor; a page past the stack cannot be opened.
 */
export type PageCursors = readonly (string | null)[];

/** One listing as the server answers it: the page, its order and its filters. */
export interface Listing {
	readonly pageIndex: number;
	readonly pageSize: number;
	readonly sorting: readonly TableSort[];
	readonly query: string;
	readonly status: MemberStatusFilter;
	readonly cursors: PageCursors;
}

export function createUsersClientState() {
	const store = createStore({
		users: cell<readonly TenantMember[]>([]),
		roles: cell<UsersContext['roles']>([]),
		grantableScopes: cell<readonly string[]>([]),
		actor: cell<UsersContext['actor'] | null>(null),
		passwordMinLength: 12,
		memberCount: 0,
		query: '',
		/** The term the rows on screen answer; typing moves `query` ahead of it. */
		appliedQuery: '',
		statusFilter: cell<MemberStatusFilter>(''),
		sorting: cell<readonly TableSort[]>(DEFAULT_MEMBER_SORTING),
		pageIndex: 0,
		pageSize: 25,
		cursors: cell<PageCursors>([null]),
		nextCursor: cell<string | null>(null),
		filtersOpen: false,
		selectedIds: cell<ReadonlySet<string>>(new Set()),
		confirmDeactivateMany: false,
		roleDialogOpen: false,
		bulkRole: '',
		formOpen: false,
		formSession: 0,
		inviteOpen: false,
		inviteSession: 0,
		selectedAccountId: cell<string | null>(null),
		status: cell<UsersStatus>('idle'),
		error: '',
		notice: '',
		/* A started export outlives the click that started it, so it carries its
		   own line to the Exports screen instead of the notice every other action
		   shares and the next one overwrites. */
		exportStarted: false,
	});
	return { store, state: store.state };
}

export type UsersClientState = ReturnType<typeof createUsersClientState>;

/** The server's sort key and direction behind the table's sorting state. */
export function memberSort(sorts: readonly TableSort[]): {
	readonly sort: TenantMemberSort;
	readonly direction: 'asc' | 'desc';
} {
	const first = sorts[0] ?? DEFAULT_MEMBER_SORTING[0]!;
	return {
		sort: first.key === 'email' ? 'email' : 'displayName',
		direction: first.desc ? 'desc' : 'asc',
	};
}

/** The cursor that opens `pageIndex`, or undefined when the reader never reached it. */
export function pageCursor(
	cursors: PageCursors,
	pageIndex: number,
): string | null | undefined {
	return pageIndex < cursors.length ? cursors[pageIndex] : undefined;
}

/**
 * Records what the page at `pageIndex` answered: the cursor of the page after
 * it, or nothing when it was the last. Pages beyond the next one are dropped,
 * since the set may have changed under them.
 */
export function rememberNextCursor(
	cursors: PageCursors,
	pageIndex: number,
	nextCursor: string | null,
): PageCursors {
	const kept = cursors.slice(0, pageIndex + 1);
	return nextCursor === null ? kept : [...kept, nextCursor];
}

export function resetPageCursors(): PageCursors {
	return [null];
}

/**
 * What a loaded page writes to the screen. The selection is emptied with every
 * listing, on a page, sort or filter change as much as on a refresh, because a
 * selected id names a row the reader saw on the page that is being replaced.
 */
export function loadedListing(
	next: Listing,
	page: MemberListPage,
): {
	readonly users: readonly TenantMember[];
	readonly appliedQuery: string;
	readonly pageIndex: number;
	readonly cursors: PageCursors;
	readonly nextCursor: string | null;
	readonly selectedIds: ReadonlySet<string>;
} {
	return {
		users: page.items,
		appliedQuery: next.query,
		pageIndex: next.pageIndex,
		cursors: rememberNextCursor(
			next.cursors,
			next.pageIndex,
			page.page.nextCursor,
		),
		nextCursor: page.page.nextCursor,
		selectedIds: new Set(),
	};
}

/** The selected rows a bulk action may name: on screen and never the acting principal. */
export function bulkTargets(
	users: readonly TenantMember[],
	selected: ReadonlySet<string>,
	actorAccountId: string | undefined,
): readonly string[] {
	return users
		.filter(
			(user) =>
				selected.has(user.accountId) && user.accountId !== actorAccountId,
		)
		.map((user) => user.accountId);
}

/** How many ids each outcome covered, for the toast after a bulk action. */
export function bulkOutcomeCounts(outcomes: readonly MemberBulkOutcome[]): {
	readonly updated: number;
	readonly missing: number;
	readonly refused: number;
} {
	let updated = 0;
	let missing = 0;
	let refused = 0;
	for (const entry of outcomes) {
		if (entry.outcome === 'updated') updated += 1;
		else if (entry.outcome === 'not-found') missing += 1;
		else refused += 1;
	}
	return { updated, missing, refused };
}

export function searchPending(query: string, applied: string): boolean {
	return query.trim() !== applied;
}

/* The server ordered the page, so a changed row keeps its place until the next
   read; a row that is not on this page changes nothing here. */
export function replaceMember(
	users: readonly TenantMember[],
	member: TenantMember,
): readonly TenantMember[] {
	return users.map((user) =>
		user.accountId === member.accountId ? member : user,
	);
}

/* The membership route answers with stable codes; each one gets the sentence
   that says what to do instead, and anything else keeps the server message. */
export function membershipStatusMessage(error: unknown): string {
	const code = error instanceof ApiError ? error.code : '';
	if (code === 'SELF_TARGET') return t('users.membership.errorSelf');
	if (code === 'LAST_OWNER') return t('users.membership.errorLastOwner');
	if (code === 'OWNER_REQUIRED')
		return t('users.membership.errorOwnerRequired');
	if (code === 'ACCOUNT_NOT_FOUND') return t('users.membership.errorNotFound');
	return error instanceof Error && error.message !== ''
		? error.message
		: t('users.membership.error');
}
