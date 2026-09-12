import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_LIMITS, type AccessReview } from '../src/domain/types.ts';
import type { AccessDirectory } from '../src/services/directory.ts';
import { buildReview } from '../src/services/review.ts';
import { openHarness, PASSWORD, type Harness } from './support/harness.ts';

let harness: Harness;

beforeAll(async () => {
	harness = await openHarness();
});

afterAll(async () => {
	await harness?.dispose();
});

async function reviewOf(session: Parameters<Harness['owner']>[0]) {
	const response = await harness.call('/api/access/review', { session });
	const body = (await response.json()) as { review: AccessReview };
	return { response, review: body.review };
}

/* A directory that answers exactly what a case needs, for the shapes the real
   auth runtime cannot produce in a test: an expired token, and a workspace
   larger than the listing bound. */
function stubDirectory(
	overrides: Partial<AccessDirectory> = {},
): AccessDirectory {
	return {
		members: async () => [],
		memberPage: async () => ({ members: [], nextCursor: null }),
		roles: async () => [],
		tokens: async () => [],
		providers: async () => [],
		auditPage: async () => [],
		...overrides,
	};
}

describe('ACCESS-REVIEW the review lists who holds what', () => {
	it('names memberships, roles, the scopes held beyond a role and the usable tokens', async () => {
		const workspace = await harness.signUp('ada@example.com', 'review-one');
		const owner = await harness.owner(workspace);
		const service = await harness.service();
		const member = await service.createTenantMember(
			{
				tenantId: workspace.tenantId,
				email: 'grace@example.com',
				password: PASSWORD,
				displayName: 'Grace Member',
				role: 'member',
			},
			owner,
		);
		const roles = await service.listRoles(workspace.tenantId);
		const memberRole = roles.find((role) => role.key === 'member')!;
		const extra = owner.scopes.find(
			(scope) => !memberRole.scopes.includes(scope),
		)!;
		await service.setMembershipScopes(owner, member.accountId, [
			...memberRole.scopes,
			extra,
		]);
		const issued = await service.issueApiToken({
			tenantId: workspace.tenantId,
			accountId: workspace.accountId,
			label: 'Deployment token',
			scopes: [owner.scopes[0]!],
			expiresAt: null,
			createdBy: workspace.accountId,
		});

		const { response, review } = await reviewOf(workspace);

		expect(response.status).toBe(200);
		expect(
			review.members.map((entry) => [
				entry.email,
				entry.role,
				entry.membershipStatus,
				entry.accountStatus,
			]),
		).toEqual(
			expect.arrayContaining([
				['ada@example.com', 'owner', 'active', 'active'],
				['grace@example.com', 'member', 'active', 'active'],
			]),
		);
		expect(
			review.members.find((entry) => entry.email === 'grace@example.com')!
				.extraScopes,
		).toEqual([extra]);
		expect(review.counts.members).toBe(2);
		expect(review.counts.activeMembers).toBe(2);
		expect(review.counts.extraScopeGrants).toBeGreaterThanOrEqual(1);
		expect(
			review.roles.map((role) => [role.key, role.builtin, role.holders]),
		).toEqual(
			expect.arrayContaining([
				['owner', true, 1],
				['member', true, 1],
			]),
		);
		expect(
			review.tokens.map((token) => [token.label, token.accountLabel]),
		).toEqual([['Deployment token', 'ada@example.com']]);
		expect(review.tokens[0]!.prefix).toBe(issued.record.prefix);
		expect(review.counts.tokens).toBe(1);
	});

	it('carries no credential of any kind', async () => {
		const workspace = await harness.signUp('carol@example.com', 'review-two');
		const service = await harness.service();
		const issued = await service.issueApiToken({
			tenantId: workspace.tenantId,
			accountId: workspace.accountId,
			label: 'Secret carrier',
			scopes: [(await harness.owner(workspace)).scopes[0]!],
			expiresAt: null,
			createdBy: workspace.accountId,
		});

		const response = await harness.call('/api/access/review', {
			session: workspace,
		});
		const text = await response.text();

		expect(text).not.toContain(issued.token);
		expect(text).not.toContain('tokenHash');
		expect(text).not.toContain('secretFingerprint');
		expect(text).not.toContain('clientSecret');
		expect(text).not.toContain('passwordHash');
	});
});

describe('ACCESS-REVIEW-TOKENS the review answers who holds access now', () => {
	it('leaves out a revoked token and counts only the usable ones', async () => {
		const workspace = await harness.signUp('linus@example.com', 'review-three');
		const owner = await harness.owner(workspace);
		const service = await harness.service();
		const kept = await service.issueApiToken({
			tenantId: workspace.tenantId,
			accountId: workspace.accountId,
			label: 'Kept token',
			scopes: [owner.scopes[0]!],
			expiresAt: null,
			createdBy: workspace.accountId,
		});
		const revoked = await service.issueApiToken({
			tenantId: workspace.tenantId,
			accountId: workspace.accountId,
			label: 'Revoked token',
			scopes: [owner.scopes[0]!],
			expiresAt: null,
			createdBy: workspace.accountId,
		});
		await service.revokeApiToken(
			workspace.tenantId,
			revoked.record.id,
			workspace.accountId,
		);

		const { review } = await reviewOf(workspace);

		expect(review.tokens.map((token) => token.id)).toEqual([kept.record.id]);
		expect(review.counts.tokens).toBe(1);
	});

	it('leaves out a token whose expiry has passed', async () => {
		const now = Date.UTC(2026, 8, 12, 12, 0, 0);
		const token = (id: string, expiresAt: number | null) => ({
			id,
			label: id,
			prefix: 'clat_ab',
			accountId: 'account-1',
			scopes: ['access.review.read'],
			createdAt: now - 1_000,
			expiresAt,
			lastUsedAt: null,
			revokedAt: null,
		});

		const review = await buildReview(
			stubDirectory({
				tokens: async () => [
					token('live', now + 1_000),
					token('expired', now - 1),
					token('eternal', null),
				],
			}),
			'tenant-1',
			now,
		);

		expect(review.tokens.map((entry) => entry.id)).toEqual(['live', 'eternal']);
		expect(review.counts.tokens).toBe(2);
	});
});

describe('the review bounds what it lists and stays exact about what it counted', () => {
	it('caps a section at its bound, says so, and still counts the whole workspace', async () => {
		const members = Array.from(
			{ length: ACCESS_LIMITS.members + 3 },
			(_unused, index) => ({
				accountId: `account-${index}`,
				email: `person-${index}@example.com`,
				displayName: `Person ${index}`,
				role: 'member',
				roleId: 'role-member',
				status: 'active',
				membershipStatus: index === 0 ? 'disabled' : 'active',
				scopes: ['access.review.read'],
			}),
		);

		const review = await buildReview(
			stubDirectory({
				members: async () => members,
				roles: async () => [
					{
						id: 'role-member',
						key: 'member',
						name: 'Member',
						builtin: true,
						scopes: ['access.review.read'],
					},
				],
			}),
			'tenant-1',
			1,
		);

		expect(review.members).toHaveLength(ACCESS_LIMITS.members);
		expect(review.capped).toEqual(['members']);
		expect(review.counts.members).toBe(members.length);
		expect(review.counts.activeMembers).toBe(members.length - 1);
		expect(review.counts.extraScopeGrants).toBe(0);
	});

	it('reports an identity provider by its rules and never by its secret', async () => {
		const review = await buildReview(
			stubDirectory({
				providers: async () => [
					{
						id: 'provider-1',
						key: 'okta',
						label: 'Okta',
						issuer: 'https://okta.example',
						status: 'active',
						scope: 'tenant',
						jitEnabled: true,
						jitRole: 'member',
						allowedDomains: ['example.com'],
						updatedAt: 10,
					},
				],
			}),
			'tenant-1',
			1,
		);

		expect(review.providers).toEqual([
			{
				id: 'provider-1',
				key: 'okta',
				label: 'Okta',
				issuer: 'https://okta.example',
				status: 'active',
				scope: 'tenant',
				jitEnabled: true,
				jitRole: 'member',
				allowedDomains: ['example.com'],
				updatedAt: 10,
			},
		]);
		expect(review.counts.providers).toBe(1);
	});
});
