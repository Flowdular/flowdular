import {
	ACCESS_LIMITS,
	type AccessReview,
	type AccessReviewMember,
	type AccessReviewProvider,
	type AccessReviewRole,
	type AccessReviewSection,
	type AccessReviewToken,
} from '../domain/types.ts';
import type {
	AccessDirectory,
	DirectoryMember,
	DirectoryRole,
} from './directory.ts';

/**
 * The scopes of the role a membership is assigned, by role id and by role key.
 * The key is the fallback: a membership written before roles became rows keeps
 * the role string and no id, and a review that ignored that would report every
 * scope of those members as an extra grant.
 */
function roleScopeIndex(
	roles: readonly DirectoryRole[],
): (member: DirectoryMember) => ReadonlySet<string> {
	const byId = new Map<string, ReadonlySet<string>>();
	const byKey = new Map<string, ReadonlySet<string>>();
	for (const role of roles) {
		const scopes: ReadonlySet<string> = new Set(role.scopes);
		byId.set(role.id, scopes);
		byKey.set(role.key, scopes);
	}
	const none: ReadonlySet<string> = new Set();
	return (member) =>
		(member.roleId === null ? undefined : byId.get(member.roleId)) ??
		byKey.get(member.role) ??
		none;
}

function reviewMember(
	member: DirectoryMember,
	granted: ReadonlySet<string>,
): AccessReviewMember {
	return {
		accountId: member.accountId,
		email: member.email,
		displayName: member.displayName,
		role: member.role,
		roleId: member.roleId,
		accountStatus: member.status,
		membershipStatus: member.membershipStatus,
		scopeCount: member.scopes.length,
		/* The scope universe is the declared permissions of the installed
		   modules, so this stays a handful of entries even for a member somebody
		   granted everything. */
		extraScopes: member.scopes.filter((scope) => !granted.has(scope)).sort(),
	};
}

/**
 * The review rows of one page of memberships. The row shape and the extra-grant
 * rule are the review's, so a file of the review carries exactly what the screen
 * shows; only how many members are read at a time differs.
 */
export function reviewMembers(
	members: readonly DirectoryMember[],
	roles: readonly DirectoryRole[],
): readonly AccessReviewMember[] {
	const scopesOf = roleScopeIndex(roles);
	return members.map((member) => reviewMember(member, scopesOf(member)));
}

/**
 * Who holds what in one workspace, read live from auth.core. Every field is
 * copied across by name, so nothing the directory happens to carry beyond the
 * declared shape reaches a response. Time is O(members plus roles plus tokens
 * plus providers); the counts are exact even where a listing is capped.
 */
export async function buildReview(
	directory: AccessDirectory,
	tenantId: string,
	now: number,
): Promise<AccessReview> {
	const [members, roles, tokens, providers] = await Promise.all([
		directory.members(tenantId),
		directory.roles(tenantId),
		directory.tokens(tenantId),
		directory.providers(tenantId),
	]);

	const scopesOf = roleScopeIndex(roles);
	const holders = new Map<string, number>();
	const reviewed: AccessReviewMember[] = [];
	let activeMembers = 0;
	let extraScopeGrants = 0;
	for (const member of members) {
		const entry = reviewMember(member, scopesOf(member));
		extraScopeGrants += entry.extraScopes.length;
		if (member.membershipStatus === 'active' && member.status === 'active') {
			activeMembers += 1;
		}
		const roleKey = member.roleId ?? member.role;
		holders.set(roleKey, (holders.get(roleKey) ?? 0) + 1);
		if (reviewed.length < ACCESS_LIMITS.members) reviewed.push(entry);
	}

	const reviewedRoles: AccessReviewRole[] = roles
		.slice(0, ACCESS_LIMITS.roles)
		.map((role) => ({
			id: role.id,
			key: role.key,
			name: role.name,
			builtin: role.builtin,
			scopes: role.scopes,
			holders: (holders.get(role.id) ?? 0) + (holders.get(role.key) ?? 0),
		}));

	const labels = new Map(
		members.map((member) => [member.accountId, member.email]),
	);
	/* A review answers who holds access now, so a revoked or expired token is
	   not access any more. Both events stay visible in the activity report. */
	const usable = tokens.filter(
		(token) =>
			token.revokedAt === null &&
			(token.expiresAt === null || token.expiresAt > now),
	);
	const reviewedTokens: AccessReviewToken[] = usable
		.slice(0, ACCESS_LIMITS.tokens)
		.map((token) => ({
			id: token.id,
			label: token.label,
			prefix: token.prefix,
			accountId: token.accountId,
			accountLabel: labels.get(token.accountId) ?? null,
			scopes: token.scopes,
			createdAt: token.createdAt,
			expiresAt: token.expiresAt,
			lastUsedAt: token.lastUsedAt,
		}));

	const reviewedProviders: AccessReviewProvider[] = providers
		.slice(0, ACCESS_LIMITS.providers)
		.map((provider) => ({
			id: provider.id,
			key: provider.key,
			label: provider.label,
			issuer: provider.issuer,
			status: provider.status,
			scope: provider.scope,
			jitEnabled: provider.jitEnabled,
			jitRole: provider.jitRole,
			allowedDomains: provider.allowedDomains,
			updatedAt: provider.updatedAt,
		}));

	const capped: AccessReviewSection[] = [];
	if (reviewed.length < members.length) capped.push('members');
	if (reviewedRoles.length < roles.length) capped.push('roles');
	if (reviewedTokens.length < usable.length) capped.push('tokens');
	if (reviewedProviders.length < providers.length) capped.push('providers');

	return {
		generatedAt: now,
		members: reviewed,
		roles: reviewedRoles,
		tokens: reviewedTokens,
		providers: reviewedProviders,
		counts: {
			members: members.length,
			activeMembers,
			roles: roles.length,
			extraScopeGrants,
			tokens: usable.length,
			providers: providers.length,
		},
		capped,
	};
}
