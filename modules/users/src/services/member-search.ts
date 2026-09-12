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

/**
 * Terms of one query the provider may push down. auth.core matches a prefix,
 * so a term that opens no name and no address answers nothing and the next one
 * has to be asked for; the cap keeps a long query to a bounded number of reads
 * of at most `MEMBER_SEARCH_SCAN_LIMIT` rows each, at the price of not finding
 * a member only the fourth term or later opens.
 */
export const MEMBER_SEARCH_PUSHDOWN_LIMIT = 3;

/** The view a hit opens, as the users client contribution registers it. */
const MEMBER_VIEW_ID = 'users';

function aborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/**
 * The terms the query names, in the order they were typed. A query of only
 * whitespace names none and reads nothing.
 */
function searchTerms(query: string): readonly string[] {
	return query.split(' ').filter((term) => term.length > 0);
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
			const terms = searchTerms(input.query);
			if (terms.length === 0) return { hits: [], nextCursor: null };
			const service = await auth.service();
			const pushdowns = Math.min(terms.length, MEMBER_SEARCH_PUSHDOWN_LIMIT);
			/* The port matches a prefix, so the term typed first is not
			   necessarily the one that opens the member: "lovelace ada" has to
			   fall through to "ada" to reach Ada Lovelace. Each term is pushed
			   in turn until one answers rows, and `matchMembers` still requires
			   every term over what came back. */
			let members: readonly TenantMember[] = [];
			for (let index = 0; index < pushdowns; index += 1) {
				members = await service.searchTenantMembers(input.tenantId, {
					query: terms[index]!,
					limit: MEMBER_SEARCH_SCAN_LIMIT,
				});
				if (members.length > 0) break;
				if (aborted(input.signal)) return { hits: [], nextCursor: null };
			}
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
