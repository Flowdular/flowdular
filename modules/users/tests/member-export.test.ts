import {
	CSV_BOM,
	CSV_RECORD_SEPARATOR,
	runListExport,
} from '@flowdular/server';
import type { DatabaseProvider } from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import type { AuthPrincipal, TenantMember } from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import { createAuthRuntime } from '@flowdular/module-auth/server';
import { EXPORT_LISTS_CAPABILITY } from '@flowdular/module-exports';
import { createExportListRegistry } from '@flowdular/module-exports/server';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMBER_EXPORT_LIST_ID } from '../src/domain/lists.ts';
import {
	createMemberListExport as publicListExport,
	MEMBER_EXPORT_LIST_ID as publicListId,
} from '../src/index.ts';
import { createServerComposition } from '../src/platform.ts';
import { createMemberListExport } from '../src/services/member-export.ts';
import { UsersService } from '../src/services/users-service.ts';

const opened: { runtime: AuthRuntime; databases: DatabaseProvider }[] = [];

afterEach(async () => {
	for (const entry of opened.splice(0)) {
		await entry.runtime.dispose();
		await entry.databases.dispose();
	}
});

/* The real auth runtime over an embedded PostgreSQL, composed the way the
   platform composes it, so the walk is exercised against the administration
   port rather than a stand-in for it. */
function authRuntime(): AuthRuntime {
	const databases = createPgliteTestProvider();
	const runtime = createAuthRuntime({
		databases,
		purpose: 'test',
		secureCookies: false,
		cookieName: 'coreloom_session_dev',
		sessionTtlMs: 3_600_000,
		sessionIdleMs: 3_600_000,
		passwordMinLength: 12,
		allowSignUp: true,
		emailConfirmation: false,
		signInProviders: [],
	});
	opened.push({ runtime, databases });
	return runtime;
}

async function workspace(
	auth: AuthRuntime,
	email: string,
	slug: string,
): Promise<AuthPrincipal> {
	const issued = await (
		await auth.service()
	).signUp({
		email,
		password: 'correct horse battery staple',
		displayName: 'Owner Person',
		organizationName: 'Workspace',
		organizationSlug: slug,
	});
	return issued.principal;
}

/* Members without a credential: the export reads the membership roll, and
   hashing a password per member would cost the suite seconds for nothing. */
async function fill(
	auth: AuthRuntime,
	principal: AuthPrincipal,
	prefix: string,
	count: number,
): Promise<void> {
	const users = new UsersService(auth);
	for (let number = 1; number <= count; number += 1) {
		await users.createWithoutPassword(principal, {
			email: `${prefix}-${number}@example.com`,
			displayName: `Member ${number}`,
			role: 'member',
		});
	}
}

async function roll(
	auth: AuthRuntime,
	tenantId: string,
): Promise<readonly TenantMember[]> {
	return [...(await (await auth.service()).listTenantMembers(tenantId))].sort(
		(left, right) => (left.accountId < right.accountId ? -1 : 1),
	);
}

interface File {
	readonly header: string;
	readonly records: readonly string[];
	readonly rows: number;
	readonly pages: number;
}

async function exported(
	auth: AuthRuntime,
	principal: AuthPrincipal,
	pageLimit: number,
): Promise<File> {
	const result = await runListExport({
		definition: createMemberListExport(auth),
		principal,
		bounds: { maxRows: 1_000, maxBytes: 1_048_576, pageLimit },
	});
	const lines = Buffer.from(result.body)
		.toString('utf8')
		.slice(CSV_BOM.length)
		.split(CSV_RECORD_SEPARATOR)
		.filter((line) => line !== '');
	return {
		header: lines[0] ?? '',
		records: lines.slice(1),
		rows: result.rows,
		pages: result.pages,
	};
}

function field(record: string, index: number): string {
	return record.split(',')[index] ?? '';
}

describe('the members list export', () => {
	it('declares the columns USERS-EXPORT names, behind the members read permission', () => {
		const definition = createMemberListExport({} as AuthRuntime);

		expect(definition.id).toBe('users.core.members');
		expect(definition.permission).toBe('users.members.read');
		expect(definition.columns.map((column) => column.key)).toEqual([
			'email',
			'displayName',
			'role',
			'status',
			'joinedAt',
		]);
		expect(definition.columns.map((column) => column.header)).toEqual([
			'E-mail',
			'Display name',
			'Role',
			'Status',
			'Joined at',
		]);
	});

	/* USERS-EXPORT: the walk is the contract. Every member of the workspace has
	   to reach the file exactly once however many pages it takes, which is what
	   a cursor that skipped or repeated a row would break. */
	it('writes every member of the workspace once over a walk of several pages', async () => {
		const auth = authRuntime();
		const owner = await workspace(auth, 'owner@example.com', 'export-walk');
		await fill(auth, owner, 'member', 6);
		const members = await roll(auth, owner.tenantId);

		const file = await exported(auth, owner, 2);

		expect(members).toHaveLength(7);
		expect(file.pages).toBeGreaterThan(1);
		expect(file.rows).toBe(members.length);
		expect(file.header).toBe('E-mail,Display name,Role,Status,Joined at');
		expect(file.records.map((record) => field(record, 0))).toEqual(
			members.map((member) => member.email),
		);
		expect(file.records.map((record) => field(record, 2))).toEqual(
			members.map((member) => member.role),
		);
		expect(file.records.map((record) => field(record, 3))).toEqual(
			members.map((member) => member.membershipStatus),
		);
		expect(field(file.records[0] ?? '', 4)).toBe(
			new Date(members[0]!.createdAt).toISOString(),
		);
	});

	/* USERS-EXPORT: one page of the export is one page of the port. A walk that
	   asked for the whole roll per page would read M rows for every L it wrote,
	   which is the difference this pins. */
	it('asks the port for one page at a time over a walk of three pages', async () => {
		const auth = authRuntime();
		const owner = await workspace(auth, 'owner@example.com', 'export-paged');
		await fill(auth, owner, 'member', 5);
		const members = await roll(auth, owner.tenantId);
		const service = await auth.service();
		const asked: (number | 'roll')[] = [];
		const watched = {
			service: async () => ({
				listTenantMembers: (
					tenantId: string,
					page?: { readonly cursor?: string | null; readonly limit: number },
				) => {
					asked.push(page === undefined ? 'roll' : page.limit);
					return page === undefined
						? service.listTenantMembers(tenantId)
						: service.listTenantMembers(tenantId, page);
				},
			}),
		} as unknown as AuthRuntime;

		const file = await exported(watched, owner, 2);

		expect(members).toHaveLength(6);
		expect(asked).toEqual([2, 2, 2]);
		expect(file.pages).toBe(3);
		expect(file.rows).toBe(6);
		expect(file.records.map((record) => field(record, 0))).toEqual(
			members.map((member) => member.email),
		);
	});

	/* The keyset is the account id, so a rename that reorders the roll the port
	   orders by display name cannot move a member across a page boundary. */
	it('writes a member renamed mid-walk once, wherever the rename moves them', async () => {
		const auth = authRuntime();
		const owner = await workspace(auth, 'owner@example.com', 'export-rename');
		await fill(auth, owner, 'member', 4);
		const members = await roll(auth, owner.tenantId);
		const definition = createMemberListExport(auth);

		const first = await definition.page(owner, null, 2);
		/* The last member of the walk is renamed to sort first by display name. */
		const last = members.at(-1)!;
		await new UsersService(auth).rename(owner, last.accountId, 'Aaa First');
		const second = await definition.page(owner, first.nextCursor, 2);
		const third = await definition.page(owner, second.nextCursor, 2);

		const written = [...first.records, ...second.records, ...third.records].map(
			(record) => field(record, 0),
		);
		expect(written).toEqual(members.map((member) => member.email));
		expect(new Set(written).size).toBe(members.length);
		expect(third.nextCursor).toBeNull();
	});

	it('answers the whole roll in one page when the page carries it', async () => {
		const auth = authRuntime();
		const owner = await workspace(auth, 'owner@example.com', 'export-single');
		await fill(auth, owner, 'member', 3);

		const file = await exported(auth, owner, 200);

		expect(file.pages).toBe(1);
		expect(file.rows).toBe(4);
	});

	it('never carries a member of another workspace', async () => {
		const auth = authRuntime();
		const owner = await workspace(auth, 'owner@example.com', 'export-here');
		const elsewhere = await workspace(
			auth,
			'other@example.com',
			'export-there',
		);
		await fill(auth, owner, 'here', 2);
		await fill(auth, elsewhere, 'there', 5);

		const file = await exported(auth, owner, 2);

		expect(file.rows).toBe(3);
		expect(file.records.map((record) => field(record, 0)).sort()).toEqual([
			'here-1@example.com',
			'here-2@example.com',
			'owner@example.com',
		]);
	});

	/* The keyset is an account id, so the row it names does not have to still be
	   there: a member removed while a long walk runs would end the job if the
	   page looked its cursor up instead of sorting after it. */
	it('pages on after the member it was walking from left the workspace', async () => {
		const auth = authRuntime();
		const owner = await workspace(auth, 'owner@example.com', 'export-removed');
		await fill(auth, owner, 'member', 5);
		const members = await roll(auth, owner.tenantId);
		/* Account ids decide the order, so which position the owner holds is not
		   this test's to choose: the walk leaves from the first member that is
		   neither the owner nor the last row. */
		const index = members.findIndex(
			(member, position) =>
				member.accountId !== owner.accountId && position < members.length - 1,
		);
		const gone = members[index]!;
		const after = members.slice(index + 1);
		await new UsersService(auth).remove(owner, gone.accountId);

		const page = await createMemberListExport(auth).page(
			owner,
			gone.accountId,
			10,
		);

		expect(page.rows).toBe(after.length);
		expect(page.nextCursor).toBeNull();
		expect(page.records.map((record) => field(record, 0))).toEqual(
			after.map((member) => member.email),
		);
	});

	it('offers the declaration and its list id on the module’s public entry', () => {
		expect(publicListExport).toBe(createMemberListExport);
		expect(publicListId).toBe(MEMBER_EXPORT_LIST_ID);
	});
});

describe('users.core composition', () => {
	/* USERS-EXPORT: registered into the real catalogue, so the namespace rule it
	   enforces is part of what this covers. */
	it('registers the members list when exports.core is composed', () => {
		const registry = createExportListRegistry();

		createServerComposition({
			auth: {} as AuthRuntime,
			capabilities: {
				get: (id: string) => (id === EXPORT_LISTS_CAPABILITY ? registry : null),
			},
		} as never);

		expect(registry.list().map((entry) => entry.id)).toEqual([
			MEMBER_EXPORT_LIST_ID,
		]);
		expect(registry.find(MEMBER_EXPORT_LIST_ID)?.moduleId).toBe('users.core');
	});

	/* USERS-EXPORT: the capability is optional, so nothing orders exports.core
	   first. A registry that only exists by the time start hooks run still gets
	   the declaration, and the module that already registered does not register
	   a second time into the same catalogue. */
	it('registers the members list when exports.core composes after this module', () => {
		let registry: ReturnType<typeof createExportListRegistry> | null = null;

		const composition = createServerComposition({
			auth: {} as AuthRuntime,
			capabilities: {
				get: (id: string) => (id === EXPORT_LISTS_CAPABILITY ? registry : null),
			},
		} as never);
		registry = createExportListRegistry();
		composition.start!();

		expect(registry.list().map((entry) => entry.id)).toEqual([
			MEMBER_EXPORT_LIST_ID,
		]);
	});

	it('registers the members list once when both hooks see the catalogue', () => {
		const registry = createExportListRegistry();

		const composition = createServerComposition({
			auth: {} as AuthRuntime,
			capabilities: {
				get: (id: string) => (id === EXPORT_LISTS_CAPABILITY ? registry : null),
			},
		} as never);
		composition.start!();

		expect(registry.list()).toHaveLength(1);
	});

	/* USERS-EXPORT: the capability is optional, so a deployment that leaves
	   exports.core out still composes this module rather than failing at boot. */
	it('composes without the export capability', () => {
		const composition = createServerComposition({
			auth: {} as AuthRuntime,
			capabilities: { get: () => null },
		} as never);

		expect(composition.routes.length).toBeGreaterThan(0);
	});
});
