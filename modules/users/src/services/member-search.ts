import type { TenantMember } from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import type {
	SearchHit,
	SearchProvider,
	SearchProviderPage,
	SearchProviderQuery,
} from '@flowdular/module-search';
import { USER_PERMISSIONS } from '../acl/permissions.ts';

export const MEMBER_SEARCH_PROVIDER_KEY = 'users.members';

/**
 * Members one query may read. auth.core applies both the predicate and this
 * limit in SQL, so the read is the matching rows rather than the workspace.
 * Ranking and the multi-term rule still run here, over that bounded set.
 */
export const MEMBER_SEARCH_SCAN_LIMIT = 500;

/** The view a hit opens, as the users client contribution registers it. */
const MEMBER_VIEW_ID = 'users';

function aborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/**
 * The one term the database filters on. Every term still has to land, and
 * `matchMembers` checks that over what comes back; pushing the longest term
 * down keeps the read the most selective one a single predicate can be, and
 * keeps a reordered query ("lovelace ada") matching what "ada lovelace" does.
 * A query of only whitespace names no term and reads nothing.
 */
function selectiveTerm(query: string): string | undefined {
	let longest: string | undefined;
	for (const term of query.split(' ')) {
		if (
			term.length > 0 &&
			(longest === undefined || term.length > longest.length)
		) {
			longest = term;
		}
	}
	return longest;
}

/**
 * How well one member answers the query. Only compared against other members,
 * so the scale is this provider's own: an exact address beats a name that
 * starts with the term, which beats a term found anywhere.
 */
export function memberScore(member: TenantMember, term: string): number {
	const name = member.displayName.toLowerCase();
	const email = member.email.toLowerCase();
	if (email === term) return 1;
	if (name === term) return 0.9;
	if (name.startsWith(term)) return 0.8;
	if (email.startsWith(term)) return 0.7;
	if (name.includes(term)) return 0.5;
	if (email.includes(term)) return 0.4;
	return 0;
}

/** Every term has to land somewhere, so "ada lovelace" does not match "ada". */
export function matchMembers(
	members: readonly TenantMember[],
	query: string,
): readonly { readonly member: TenantMember; readonly score: number }[] {
	const terms = query.toLowerCase().split(' ').filter(Boolean);
	if (terms.length === 0) return [];
	const matched: { member: TenantMember; score: number }[] = [];
	for (const member of members) {
		let best = 0;
		let all = true;
		for (const term of terms) {
			const score = memberScore(member, term);
			if (score === 0) {
				all = false;
				break;
			}
			if (score > best) best = score;
		}
		if (all) matched.push({ member, score: best });
	}
	matched.sort(
		(left, right) =>
			right.score - left.score ||
			left.member.displayName.localeCompare(right.member.displayName) ||
			left.member.accountId.localeCompare(right.member.accountId),
	);
	return matched;
}

function toHit(member: TenantMember, score: number): SearchHit {
	return {
		ref: member.accountId,
		title: member.displayName,
		snippet: member.email,
		viewId: MEMBER_VIEW_ID,
		route: '/users?member=' + encodeURIComponent(member.accountId),
		score,
	};
}

/**
 * The workspace's members as a search provider. Every read goes through the
 * auth administration port with the tenant of the principal search.core
 * resolved, so this module still opens no table of another one.
 */
export function createMemberSearchProvider(auth: AuthRuntime): SearchProvider {
	return {
		key: MEMBER_SEARCH_PROVIDER_KEY,
		label: 'Members',
		permission: USER_PERMISSIONS.read,
		async search(input: SearchProviderQuery): Promise<SearchProviderPage> {
			if (aborted(input.signal)) return { hits: [], nextCursor: null };
			const term = selectiveTerm(input.query);
			if (term === undefined) return { hits: [], nextCursor: null };
			const members = await (
				await auth.service()
			).searchTenantMembers(input.tenantId, {
				query: term,
				limit: MEMBER_SEARCH_SCAN_LIMIT,
			});
			if (aborted(input.signal)) return { hits: [], nextCursor: null };
			const matched = matchMembers(members, input.query);
			const offset = Number(input.cursor ?? '0');
			const start =
				Number.isSafeInteger(offset) && offset >= 0 ? offset : matched.length;
			const page = matched.slice(start, start + input.limit);
			const next = start + page.length;
			return {
				hits: page.map((entry) => toHit(entry.member, entry.score)),
				nextCursor: next < matched.length ? String(next) : null,
			};
		},
	};
}
