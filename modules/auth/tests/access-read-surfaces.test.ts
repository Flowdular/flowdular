import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/services/auth-service.ts';
import type { TenantMemberPage } from '../src/services/repository.ts';
import { fastHash } from './helpers.ts';
import {
	closeAuthTestDatabases,
	createAuthTestDatabase,
	type AuthTestDatabase,
} from './support/database.ts';

/* The three read surfaces access.core records as follow-ups on auth.core: a
   date window on the audit query, a paged listing of the identity bindings a
   workspace's own providers assert, and a paged member walk. Every case runs
   against an embedded PostgreSQL, so the SQL is what is under test rather than
   a stand-in for it. */

const open = new Set<AuthTestDatabase>();

afterEach(async () => {
	await Promise.all([...open].map((database) => database.dispose()));
	open.clear();
});

afterAll(closeAuthTestDatabases);

async function workspaces() {
	const database = await createAuthTestDatabase();
	open.add(database);
	const now = { value: 1_000 };
	const service = new AuthService(database.repository, {
		passwordHash: fastHash,
		policy: () => ({
			sessionTtlMs: 12 * 60 * 60 * 1000,
			sessionIdleMs: 2 * 60 * 60 * 1000,
			passwordMinLength: 12,
		}),
		now: () => now.value,
	});
	const first = await service.signUp({
		email: 'owner@example.com',
		password: 'correct horse battery staple',
		displayName: 'Ada Owner',
		organizationName: 'Example Operations',
		organizationSlug: 'example-operations',
	});
	const second = await service.signUp({
		email: 'other@example.net',
		password: 'quiet lantern voyage steady',
		displayName: 'Bo Other',
		organizationName: 'Other Operations',
		organizationSlug: 'other-operations',
	});
	return {
		repository: database.repository,
		service,
		now,
		tenantId: first.principal.tenantId,
		ownerAccountId: first.principal.accountId,
		otherTenantId: second.principal.tenantId,
		otherAccountId: second.principal.accountId,
	};
}

describe('audit window', () => {
	it('answers the inclusive window in SQL and keeps paging inside it', async () => {
		const { repository, service, tenantId } = await workspaces();
		for (const occurredAt of [1_000, 2_000, 3_000, 4_000, 5_000]) {
			await repository.appendAudit({
				tenantId,
				actorAccountId: null,
				actorLabel: 'operator',
				actorKind: 'user',
				actorRunId: null,
				action: 'auth.tenant.renamed',
				subjectType: 'tenant',
				subjectId: tenantId,
				metadata: { occurredAt },
				occurredAt,
			});
		}

		/* Every query names the action, so the window is asserted against the
		   rows this case appended and composes with the filter that was already
		   there rather than replacing it. Signing the workspace up appended rows
		   of its own. */
		const windowed = await service.queryAudit({
			tenantId,
			action: 'auth.tenant.renamed',
			from: 2_000,
			to: 4_000,
			limit: 100,
		});
		expect(windowed.events.map((event) => event.occurredAt)).toEqual([
			4_000, 3_000, 2_000,
		]);
		expect(windowed.nextCursor).toBeNull();

		/* The keyset still cuts the window into pages, and the second page stays
		   inside the floor instead of walking past it. */
		const firstPage = await service.queryAudit({
			tenantId,
			action: 'auth.tenant.renamed',
			from: 2_000,
			to: 4_000,
			limit: 2,
		});
		expect(firstPage.events.map((event) => event.occurredAt)).toEqual([
			4_000, 3_000,
		]);
		expect(firstPage.nextCursor).not.toBeNull();
		const secondPage = await service.queryAudit({
			tenantId,
			action: 'auth.tenant.renamed',
			from: 2_000,
			to: 4_000,
			limit: 2,
			cursor: firstPage.nextCursor,
		});
		expect(secondPage.events.map((event) => event.occurredAt)).toEqual([2_000]);
		expect(secondPage.nextCursor).toBeNull();

		/* One open end bounds one side only, and no bound reads everything. */
		const renamed = (from?: number, to?: number) =>
			service.queryAudit({
				tenantId,
				action: 'auth.tenant.renamed',
				...(from === undefined ? {} : { from }),
				...(to === undefined ? {} : { to }),
				limit: 100,
			});
		expect((await renamed(4_000)).events.length).toBe(2);
		expect((await renamed(undefined, 2_000)).events.length).toBe(2);
		expect((await renamed()).events.length).toBe(5);
	});

	it('refuses a reversed window and a bound that is no timestamp', async () => {
		const { service, tenantId } = await workspaces();

		await expect(
			service.queryAudit({ tenantId, from: 5_000, to: 4_000, limit: 10 }),
		).rejects.toMatchObject({ code: 'INVALID_INPUT', status: 400 });
		await expect(
			service.queryAudit({ tenantId, from: Number.NaN, limit: 10 }),
		).rejects.toMatchObject({ code: 'INVALID_INPUT', status: 400 });
		await expect(
			service.queryAudit({ tenantId, to: 1.5, limit: 10 }),
		).rejects.toMatchObject({ code: 'INVALID_INPUT', status: 400 });
		/* A window whose ends are the same instant is not reversed. */
		await expect(
			service.queryAudit({ tenantId, from: 4_000, to: 4_000, limit: 10 }),
		).resolves.toMatchObject({ events: [] });
	});

	it('keeps the window inside the workspace of the query', async () => {
		const { repository, service, tenantId, otherTenantId } = await workspaces();
		await repository.appendAudit({
			tenantId: otherTenantId,
			actorAccountId: null,
			actorLabel: 'operator',
			actorKind: 'user',
			actorRunId: null,
			action: 'auth.tenant.renamed',
			subjectType: 'tenant',
			subjectId: otherTenantId,
			metadata: {},
			occurredAt: 3_000,
		});

		expect(
			(
				await service.queryAudit({
					tenantId,
					from: 1,
					to: 9_000,
					limit: 100,
				})
			).events.filter((event) => event.action === 'auth.tenant.renamed'),
		).toEqual([]);
	});
});

describe('external identity bindings', () => {
	it('pages the workspace bindings by provider and subject and carries no secret', async () => {
		const { repository, service, tenantId, ownerAccountId } =
			await workspaces();
		for (const [provider, subject] of [
			['okta', 'subject-b'],
			['okta', 'subject-a'],
			['entra', 'subject-c'],
		]) {
			await repository.linkExternalIdentity({
				provider: provider ?? '',
				subject: subject ?? '',
				accountId: ownerAccountId,
				tenantId,
				now: 2_000,
			});
		}

		const page = await service.listExternalIdentities(tenantId, { limit: 2 });
		expect(page.identities).toEqual([
			{
				accountId: ownerAccountId,
				provider: 'entra',
				subject: 'subject-c',
				linkedAt: 2_000,
			},
			{
				accountId: ownerAccountId,
				provider: 'okta',
				subject: 'subject-a',
				linkedAt: 2_000,
			},
		]);
		expect(page.nextCursor).toBe('okta:subject-a');

		const rest = await service.listExternalIdentities(tenantId, {
			limit: 2,
			cursor: page.nextCursor,
		});
		expect(
			rest.identities.map(
				(identity) => `${identity.provider}:${identity.subject}`,
			),
		).toEqual(['okta:subject-b']);
		expect(rest.nextCursor).toBeNull();

		/* A binding is an account, a provider key, a subject and a time, and the
		   row's other columns stay where they are. */
		expect(Object.keys(page.identities[0] ?? {}).sort()).toEqual([
			'accountId',
			'linkedAt',
			'provider',
			'subject',
		]);
	});

	it('answers no binding of another workspace and none a platform provider made', async () => {
		const {
			repository,
			service,
			tenantId,
			ownerAccountId,
			otherTenantId,
			otherAccountId,
		} = await workspaces();
		await repository.linkExternalIdentity({
			provider: 'okta',
			subject: 'mine',
			accountId: ownerAccountId,
			tenantId,
			now: 2_000,
		});
		await repository.linkExternalIdentity({
			provider: 'okta',
			subject: 'theirs',
			accountId: otherAccountId,
			tenantId: otherTenantId,
			now: 2_000,
		});
		/* A platform provider binds before a workspace is chosen, so its row
		   carries none and the policy admits it under every workspace. */
		await repository.linkExternalIdentity({
			provider: 'platform-okta',
			subject: 'unscoped',
			accountId: ownerAccountId,
			tenantId: null,
			now: 2_000,
		});

		expect(
			(await service.listExternalIdentities(tenantId, { limit: 100 }))
				.identities,
		).toEqual([
			{
				accountId: ownerAccountId,
				provider: 'okta',
				subject: 'mine',
				linkedAt: 2_000,
			},
		]);
		expect(
			(await service.listExternalIdentities(otherTenantId, { limit: 100 }))
				.identities,
		).toEqual([
			{
				accountId: otherAccountId,
				provider: 'okta',
				subject: 'theirs',
				linkedAt: 2_000,
			},
		]);
	});

	it('bounds the page it will answer', async () => {
		const { service, tenantId } = await workspaces();

		for (const limit of [0, -1, 501, 1.5]) {
			await expect(
				service.listExternalIdentities(tenantId, { limit }),
			).rejects.toMatchObject({ code: 'INVALID_INPUT', status: 400 });
		}
		await expect(
			service.listExternalIdentities(tenantId, { limit: 500 }),
		).resolves.toMatchObject({ identities: [], nextCursor: null });
	});
});

describe('paged member listing', () => {
	async function members(count: number) {
		const context = await workspaces();
		const owner = {
			accountId: context.ownerAccountId,
			tenantId: context.tenantId,
			email: 'owner@example.com',
			role: 'owner',
			scopes: ['users.members.manage'],
		};
		for (let index = 0; index < count; index += 1) {
			await context.service.createTenantMember(
				{
					tenantId: context.tenantId,
					email: `member-${index}@example.com`,
					password: 'steady tangerine harbor',
					displayName: `Member ${index}`,
					role: 'member',
				},
				owner,
			);
		}
		return context;
	}

	it('walks every member once by account id and ends', async () => {
		const { service, tenantId } = await members(4);
		const everyone = await service.listTenantMembers(tenantId);
		expect(everyone).toHaveLength(5);

		const walked: string[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 10; page += 1) {
			/* Annotated because the cursor this reads is the cursor the page it
			   answers assigns, which TypeScript cannot infer through the loop. */
			const answer: TenantMemberPage = await service.listTenantMembers(
				tenantId,
				{ limit: 2, cursor },
			);
			walked.push(...answer.members.map((member) => member.accountId));
			cursor = answer.nextCursor;
			if (cursor === null) break;
		}

		expect(cursor).toBeNull();
		expect(walked).toEqual([...walked].sort());
		expect(new Set(walked).size).toBe(walked.length);
		expect([...walked].sort()).toEqual(
			everyone.map((member) => member.accountId).sort(),
		);
		/* The paged record is the record the unbounded call answers, so a caller
		   may swap one read for the other. */
		const first = await service.listTenantMembers(tenantId, { limit: 1 });
		expect(first.members[0]).toEqual(
			everyone.find(
				(member) => member.accountId === first.members[0]?.accountId,
			),
		);
	});

	it('pages the workspace of the call and no other', async () => {
		const { service, tenantId, otherTenantId, otherAccountId } =
			await members(2);

		const page = await service.listTenantMembers(tenantId, { limit: 100 });
		expect(page.members.map((member) => member.accountId)).not.toContain(
			otherAccountId,
		);
		expect(
			(
				await service.listTenantMembers(otherTenantId, { limit: 100 })
			).members.map((member) => member.accountId),
		).toEqual([otherAccountId]);
	});

	it('bounds the page it will answer and leaves the unbounded call alone', async () => {
		const { service, tenantId } = await members(1);

		for (const limit of [0, -1, 501, 1.5]) {
			await expect(
				service.listTenantMembers(tenantId, { limit }),
			).rejects.toMatchObject({ code: 'INVALID_INPUT', status: 400 });
		}
		await expect(
			service.listTenantMembers(tenantId, { limit: 500 }),
		).resolves.toMatchObject({ nextCursor: null });
		expect(await service.listTenantMembers(tenantId)).toHaveLength(2);
	});
});
