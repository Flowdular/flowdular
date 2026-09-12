import { afterEach, describe, expect, it } from 'vitest';
import { SCIM_TOKEN_PREFIX } from '../src/services/token-service.ts';
import { ScimRateLimiter } from '../src/services/rate-limiter.ts';
import {
	issueToken,
	openHarness,
	OWNER_PASSWORD,
	type DirectoryHarness,
	type HarnessOptions,
	type Session,
} from './support/harness.ts';

const open: DirectoryHarness[] = [];

afterEach(async () => {
	for (const harness of open.splice(0)) await harness.dispose();
});

async function harness(
	options: HarnessOptions = {},
): Promise<DirectoryHarness> {
	const created = await openHarness(options);
	open.push(created);
	return created;
}

async function listTokens(
	suite: DirectoryHarness,
	session: Session,
): Promise<Record<string, unknown>[]> {
	const response = await suite.admin('/api/directory/tokens', 'GET', session);
	return ((await response.json()) as { tokens: Record<string, unknown>[] })
		.tokens;
}

async function provisioningEvents(
	suite: DirectoryHarness,
	session: Session,
): Promise<unknown[]> {
	const response = await suite.admin(
		'/api/directory/provisioning-events',
		'GET',
		session,
	);
	return ((await response.json()) as { items: unknown[] }).items;
}

/** Signs a plain member in, so the denial tests use a real principal. */
async function memberSession(
	suite: DirectoryHarness,
	owner: Session,
	email: string,
): Promise<Session> {
	const service = await suite.auth.service();
	await service.createTenantMember(
		{
			tenantId: owner.tenantId,
			email,
			password: OWNER_PASSWORD,
			displayName: 'Plain Member',
			role: 'member',
		},
		{
			accountId: owner.accountId,
			tenantId: owner.tenantId,
			email: 'owner@example.com',
			role: 'owner',
			scopes: [],
		},
	);
	const issued = await service.signIn({ email, password: OWNER_PASSWORD });
	return {
		cookie: `coreloom_session_dev=${issued.token}`,
		csrfToken: issued.csrfToken,
		accountId: issued.principal.accountId,
		tenantId: issued.principal.tenantId,
		slug: owner.slug,
	};
}

describe('DIRECTORY-TOKEN-CREATE', () => {
	it('returns the value once and only the fingerprint afterwards', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const created = await suite.admin('/api/directory/tokens', 'POST', owner, {
			label: 'Okta production',
		});
		expect(created.status).toBe(201);
		const issued = (await created.json()) as {
			token: string;
			record: { id: string; tokenFingerprint: string; status: string };
		};
		expect(issued.token.startsWith(SCIM_TOKEN_PREFIX)).toBe(true);
		expect(issued.record.status).toBe('active');

		const listed = await listTokens(suite, owner);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.tokenFingerprint).toBe(issued.record.tokenFingerprint);
		/* The reply of a listing carries neither the value nor its hash. */
		expect(JSON.stringify(listed)).not.toContain(issued.token);
		expect(Object.keys(listed[0] ?? {})).not.toContain('tokenHash');
	});

	it('refuses a duplicate label with a stable code', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		await issueToken(suite, owner, 'Okta production');
		const again = await suite.admin('/api/directory/tokens', 'POST', owner, {
			label: 'okta production',
		});
		expect(again.status).toBe(409);
		expect(
			((await again.json()) as { error: { code: string } }).error.code,
		).toBe('TOKEN_LABEL_EXISTS');
	});

	it('rotates to a new value and stops the previous one', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const first = await issueToken(suite, owner);
		const rotated = await suite.admin(
			'/api/directory/tokens/rotate',
			'POST',
			owner,
			{ id: first.id },
		);
		expect(rotated.status).toBe(200);
		const second = (await rotated.json()) as {
			token: string;
			record: { id: string };
		};
		expect(second.token).not.toBe(first.token);
		expect(second.record.id).toBe(first.id);

		const withOld = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'GET',
			token: first.token,
		});
		expect(withOld.status).toBe(401);
		const withNew = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'GET',
			token: second.token,
		});
		expect(withNew.status).toBe(200);
	});

	it('answers 401 on every SCIM request once the token is revoked', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		expect(
			(
				await suite.scim({
					workspace: owner.slug,
					template: '/Users',
					method: 'GET',
					token: token.token,
				})
			).status,
		).toBe(200);

		const revoked = await suite.admin(
			'/api/directory/tokens/revoke',
			'POST',
			owner,
			{ id: token.id },
		);
		expect(revoked.status).toBe(200);
		const after = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'GET',
			token: token.token,
		});
		expect(after.status).toBe(401);
		expect((await listTokens(suite, owner))[0]?.status).toBe('revoked');
	});

	it('refuses a member without the manage permission and writes nothing', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const member = await memberSession(suite, owner, 'member@example.com');
		const refused = await suite.admin('/api/directory/tokens', 'POST', member, {
			label: 'Sneaky',
		});
		expect(refused.status).toBe(403);
		expect(await listTokens(suite, owner)).toHaveLength(0);
	});

	it('refuses a mutation without the CSRF header', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const refused = await suite.admin(
			'/api/directory/tokens',
			'POST',
			owner,
			{ label: 'No CSRF' },
			{ csrfToken: null },
		);
		expect(refused.status).toBe(403);
		expect(
			((await refused.json()) as { error: { code: string } }).error.code,
		).toBe('CSRF_REJECTED');
		expect(await listTokens(suite, owner)).toHaveLength(0);
	});

	/* Revocation is terminal: a rotation that answered would put a working
	   credential back on a label an owner already stopped. */
	it('refuses to rotate a revoked token and leaves it revoked', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		expect(
			(
				await suite.admin('/api/directory/tokens/revoke', 'POST', owner, {
					id: token.id,
				})
			).status,
		).toBe(200);

		const rotated = await suite.admin(
			'/api/directory/tokens/rotate',
			'POST',
			owner,
			{ id: token.id },
		);

		expect(rotated.status).toBe(409);
		expect(
			((await rotated.json()) as { error: { code: string } }).error.code,
		).toBe('TOKEN_REVOKED');
		const listed = await listTokens(suite, owner);
		expect(listed[0]?.status).toBe('revoked');
		/* Nothing was minted, so the workspace still refuses the old value. */
		const refused = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'GET',
			token: token.token,
		});
		expect(refused.status).toBe(401);
	});

	it('refuses an expiry beyond one year and a label that is too short', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const far = await suite.admin('/api/directory/tokens', 'POST', owner, {
			label: 'Too far',
			expiresAt: Date.now() + 400 * 24 * 60 * 60 * 1_000,
		});
		expect(far.status).toBe(400);
		expect(((await far.json()) as { error: { code: string } }).error.code).toBe(
			'INVALID_EXPIRY',
		);
		const short = await suite.admin('/api/directory/tokens', 'POST', owner, {
			label: 'x',
		});
		expect(short.status).toBe(400);
	});
});

describe('DIRECTORY-DENY', () => {
	it('answers 401 with the SCIM error schema and writes nothing', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const other = await suite.signUp('owner-b@example.com', 'workspace-b');
		await issueToken(suite, owner);
		const foreign = await issueToken(suite, other, 'Other workspace');

		const withoutToken = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'GET',
			token: null,
		});
		expect(withoutToken.status).toBe(401);
		const body = (await withoutToken.json()) as {
			schemas: string[];
			status: string;
			reason: string;
		};
		expect(body.schemas).toEqual([
			'urn:ietf:params:scim:api:messages:2.0:Error',
		]);
		expect(body.status).toBe('401');
		expect(body.reason).toBe('UNAUTHORIZED');

		/* A token of another workspace is refused exactly like an unknown one. */
		const crossWorkspace = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'POST',
			token: foreign.token,
			body: { userName: 'smuggled@example.com' },
		});
		expect(crossWorkspace.status).toBe(401);

		const memberToken = await (
			await suite.auth.service()
		).issueApiToken({
			tenantId: owner.tenantId,
			accountId: owner.accountId,
			label: 'Member token',
			scopes: ['directory.tokens.read'],
			expiresAt: null,
			createdBy: owner.accountId,
		});
		const withMemberToken = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'POST',
			token: memberToken.token,
			body: { userName: 'smuggled@example.com' },
		});
		expect(withMemberToken.status).toBe(401);

		const unknownWorkspace = await suite.scim({
			workspace: 'no-such-workspace',
			template: '/Users',
			method: 'GET',
			token: foreign.token,
		});
		expect(unknownWorkspace.status).toBe(401);

		expect(await provisioningEvents(suite, owner)).toEqual([]);
		expect(
			(
				(await (
					await suite.scim({
						workspace: owner.slug,
						template: '/Users',
						method: 'GET',
						token: (await issueToken(suite, owner, 'Reader')).token,
					})
				).json()) as { totalResults: number }
			).totalResults,
		).toBe(0);
	});

	it('answers 429 once the per-token window is spent', async () => {
		const suite = await harness({ limiter: new ScimRateLimiter(2, 60_000) });
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const call = () =>
			suite.scim({
				workspace: owner.slug,
				template: '/Users',
				method: 'GET',
				token: token.token,
			});
		expect((await call()).status).toBe(200);
		expect((await call()).status).toBe(200);
		const limited = await call();
		expect(limited.status).toBe(429);
		expect(((await limited.json()) as { reason: string }).reason).toBe(
			'RATE_LIMITED',
		);
	});
});

/* One caller, many credentials: the per-token window gives every invented
   token a budget of its own, so the caller behind them carries the limit. */
describe('SCIM caller budget', () => {
	it('cuts off a flood of invented tokens and leaves a real one working', async () => {
		const suite = await harness({ trustProxy: true });
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const real = await issueToken(suite, owner);
		const flooder = { 'x-forwarded-for': '203.0.113.9' };
		const statuses: number[] = [];
		for (let index = 0; index < 1_024; index += 1) {
			const response = await suite.scim({
				workspace: owner.slug,
				template: '/Users',
				method: 'GET',
				token: SCIM_TOKEN_PREFIX + String(index).padStart(43, 'a'),
				headers: flooder,
			});
			statuses.push(response.status);
		}

		expect(new Set(statuses)).toEqual(new Set([401, 429]));
		expect(statuses[0]).toBe(401);
		expect(statuses.at(-1)).toBe(429);
		/* The budget is spent long before the flood ends, so all but a small
		   fraction of it is answered without a refusal line in the log. */
		expect(statuses.filter((status) => status === 401).length).toBeLessThan(
			100,
		);

		const served = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'GET',
			token: real.token,
			headers: { 'x-forwarded-for': '198.51.100.4' },
		});
		expect(served.status).toBe(200);
		/* A spent budget refuses credentials, never the caller: the same token
		   presented from the flooded address is still served. */
		const shared = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'GET',
			token: real.token,
			headers: flooder,
		});
		expect(shared.status).toBe(200);
	});

	/* With no trusted proxy the address is unknown, so one window covers every
	   caller of the workspace. Cutting that window off would let anyone refuse
	   the identity provider by spending it. */
	it('DIRECTORY-SCIM-FLOOD serves the valid token while an unidentified flood spends the shared window', async () => {
		const suite = await harness({
			limiter: new ScimRateLimiter(600, 60_000, 1_000, 4),
		});
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const real = await issueToken(suite, owner);
		const statuses: number[] = [];
		for (let index = 0; index < 12; index += 1) {
			const response = await suite.scim({
				workspace: owner.slug,
				template: '/Users',
				method: 'GET',
				token: SCIM_TOKEN_PREFIX + String(index).padStart(43, 'a'),
			});
			statuses.push(response.status);
		}

		/* Three times the budget, and not one of them cuts the caller off. */
		expect(new Set(statuses)).toEqual(new Set([401]));
		const served = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'GET',
			token: real.token,
		});
		expect(served.status).toBe(200);
	});
});
