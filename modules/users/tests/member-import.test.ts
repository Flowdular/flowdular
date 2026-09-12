import type { DatabaseProvider } from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import type { AuthPrincipal, TenantMember } from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import { createAuthRuntime } from '@flowdular/module-auth/server';
import {
	IMPORT_PORTS_CAPABILITY,
	type ImportPort,
	type ImportRow,
} from '@flowdular/module-import';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createMemberImportPort as publicImportPort,
	MEMBER_IMPORT_PORT_KEY as publicPortKey,
} from '../src/index.ts';
import { createServerComposition } from '../src/platform.ts';
import {
	createMemberImportPort,
	MEMBER_IMPORT_PORT_KEY,
} from '../src/services/member-import.ts';

const opened: { runtime: AuthRuntime; databases: DatabaseProvider }[] = [];

afterEach(async () => {
	for (const entry of opened.splice(0)) {
		await entry.runtime.dispose();
		await entry.databases.dispose();
	}
});

/* The real auth runtime over an embedded PostgreSQL, composed the way the
   platform composes it, so the port is exercised against the administration
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

function row(number: number, values: Record<string, string>): ImportRow {
	return { row: number, values };
}

async function members(
	auth: AuthRuntime,
	tenantId: string,
): Promise<readonly TenantMember[]> {
	return (await auth.service()).listTenantMembers(tenantId);
}

async function member(
	auth: AuthRuntime,
	principal: AuthPrincipal,
	email: string,
): Promise<TenantMember> {
	const found = (await members(auth, principal.tenantId)).find(
		(entry) => entry.email === email,
	);
	if (!found) throw new Error(`${email} is not a member of the workspace.`);
	return found;
}

function write(
	port: ImportPort,
	principal: AuthPrincipal,
	rows: readonly ImportRow[],
	mode: 'create-only' | 'update-existing' | 'skip-existing',
) {
	return port.write({ tenantId: principal.tenantId, principal, rows, mode });
}

describe('USERS-IMPORT', () => {
	it('creates absent members under create-only and hands out no password', async () => {
		const auth = authRuntime();
		const owner = await workspace(auth, 'owner@example.com', 'workspace-one');
		const port = createMemberImportPort(auth);
		const rows = [
			row(1, {
				email: 'Ada@Example.com',
				displayName: 'Ada Lovelace',
				role: 'member',
			}),
			row(2, { email: 'grace@example.com', displayName: 'Grace Hopper' }),
		];

		expect(
			await port.validate({
				tenantId: owner.tenantId,
				principal: owner,
				rows,
			}),
		).toEqual([]);
		const outcomes = await write(port, owner, rows, 'create-only');

		const ada = await member(auth, owner, 'ada@example.com');
		const grace = await member(auth, owner, 'grace@example.com');
		expect(outcomes).toEqual([
			{ row: 1, outcome: 'created', recordRef: ada.accountId },
			{ row: 2, outcome: 'created', recordRef: grace.accountId },
		]);
		expect(ada.displayName).toBe('Ada Lovelace');
		/* A row that names no role joins on the least privileged built-in role. */
		expect(grace.role).toBe('member');

		/* The import hands out no credential, so the owner's own password does
		   not open the imported account; an administrative reset does. */
		await expect(
			(await auth.service()).signIn({
				email: 'ada@example.com',
				password: 'correct horse battery staple',
			}),
		).rejects.toThrow();
		/* Not a secret nobody kept: none was stored at all. A random placeholder
		   would answer the credential change with INVALID_CREDENTIALS instead. */
		await expect(
			(await auth.service()).changePassword({
				accountId: ada.accountId,
				currentPassword: 'correct horse battery staple',
				newPassword: 'quiet lantern voyage',
			}),
		).rejects.toMatchObject({ code: 'PASSWORD_NOT_SET' });
		await (
			await auth.service()
		).resetMemberPassword(
			{
				accountId: owner.accountId,
				tenantId: owner.tenantId,
				email: owner.email,
				role: owner.role,
				scopes: owner.scopes,
			},
			ada.accountId,
			'quiet lantern voyage',
		);
		const session = await (
			await auth.service()
		).signIn({
			email: 'ada@example.com',
			password: 'quiet lantern voyage',
		});
		expect(session.principal.accountId).toBe(ada.accountId);
	});

	it('answers the repeat of a written file under each mode', async () => {
		const auth = authRuntime();
		const owner = await workspace(auth, 'owner@example.com', 'workspace-one');
		const port = createMemberImportPort(auth);
		const created = [
			row(1, {
				email: 'ada@example.com',
				displayName: 'Ada Lovelace',
				role: 'member',
			}),
		];
		await write(port, owner, created, 'create-only');
		const ada = await member(auth, owner, 'ada@example.com');

		expect(await write(port, owner, created, 'create-only')).toEqual([
			{ row: 1, outcome: 'failed', reason: 'ALREADY_EXISTS' },
		]);
		expect(await write(port, owner, created, 'skip-existing')).toEqual([
			{ row: 1, outcome: 'skipped', recordRef: ada.accountId },
		]);
		expect(await members(auth, owner.tenantId)).toHaveLength(2);

		const changed = [
			row(1, {
				email: 'ada@example.com',
				displayName: 'Ada King',
				role: 'owner',
			}),
		];
		expect(await write(port, owner, changed, 'update-existing')).toEqual([
			{ row: 1, outcome: 'updated', recordRef: ada.accountId },
		]);
		const updated = await member(auth, owner, 'ada@example.com');
		expect(updated.accountId).toBe(ada.accountId);
		expect(updated.displayName).toBe('Ada King');
		expect(updated.role).toBe('owner');
		expect(await members(auth, owner.tenantId)).toHaveLength(2);
	});

	it('keeps a rename that landed when the role write is refused', async () => {
		const auth = authRuntime();
		const owner = await workspace(auth, 'owner@example.com', 'workspace-one');
		const port = createMemberImportPort(auth);
		await write(
			port,
			owner,
			[row(1, { email: 'ada@example.com', displayName: 'Ada Lovelace' })],
			'create-only',
		);
		const ada = await member(auth, owner, 'ada@example.com');

		/* A role this workspace does not have: the display name is written first
		   because it is the write that cannot be refused for anything but its own
		   shape, and the row reports the change that did happen. */
		const outcomes = await write(
			port,
			owner,
			[
				row(1, {
					email: 'ada@example.com',
					displayName: 'Ada King',
					role: 'auditor',
				}),
			],
			'update-existing',
		);

		expect(outcomes[0]?.outcome).toBe('updated');
		expect(outcomes[0]?.recordRef).toBe(ada.accountId);
		expect(outcomes[0]?.reason).toMatch(/^ROLE_UNCHANGED:.+/);
		const updated = await member(auth, owner, 'ada@example.com');
		expect([updated.displayName, updated.role]).toEqual(['Ada King', 'member']);
	});

	it('fails the row when nothing was written at all', async () => {
		const auth = authRuntime();
		const owner = await workspace(auth, 'owner@example.com', 'workspace-one');
		const port = createMemberImportPort(auth);
		await write(
			port,
			owner,
			[row(1, { email: 'ada@example.com', displayName: 'Ada Lovelace' })],
			'create-only',
		);

		/* The same display name, so the role is the only write the row asks for
		   and its refusal is the whole row's. */
		const outcomes = await write(
			port,
			owner,
			[
				row(1, {
					email: 'ada@example.com',
					displayName: 'Ada Lovelace',
					role: 'auditor',
				}),
			],
			'update-existing',
		);

		expect(outcomes[0]?.outcome).toBe('failed');
		expect((await member(auth, owner, 'ada@example.com')).role).toBe('member');
	});

	it('creates a member the file adds under update-existing', async () => {
		const auth = authRuntime();
		const owner = await workspace(auth, 'owner@example.com', 'workspace-one');
		const port = createMemberImportPort(auth);

		const outcomes = await write(
			port,
			owner,
			[row(1, { email: 'grace@example.com', displayName: 'Grace Hopper' })],
			'update-existing',
		);

		expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['created']);
		expect((await member(auth, owner, 'grace@example.com')).role).toBe(
			'member',
		);
	});

	it('refuses a malformed address, a missing name, an unknown role and a repeated address', async () => {
		const auth = authRuntime();
		const owner = await workspace(auth, 'owner@example.com', 'workspace-one');
		const port = createMemberImportPort(auth);

		const verdicts = await port.validate({
			tenantId: owner.tenantId,
			principal: owner,
			rows: [
				row(1, { email: 'not-an-address', displayName: 'No Address' }),
				row(2, { email: 'blank@example.com', displayName: '   ' }),
				row(3, {
					email: 'ghost@example.com',
					displayName: 'Ghost Role',
					role: 'auditor',
				}),
				row(4, { email: 'twin@example.com', displayName: 'First Twin' }),
				row(5, { email: 'TWIN@example.com', displayName: 'Second Twin' }),
			],
		});

		/* Refusals only: row 4 is accepted by saying nothing about it. */
		expect(verdicts).toEqual([
			{ row: 1, verdict: 'invalid', field: 'email', reason: 'EMAIL_INVALID' },
			{
				row: 2,
				verdict: 'invalid',
				field: 'displayName',
				reason: 'DISPLAY_NAME_INVALID',
			},
			{ row: 3, verdict: 'invalid', field: 'role', reason: 'ROLE_UNKNOWN' },
			{ row: 5, verdict: 'invalid', field: 'email', reason: 'EMAIL_DUPLICATE' },
		]);
		expect(await members(auth, owner.tenantId)).toHaveLength(1);
	});

	it('fails the row of an address held elsewhere and leaves that workspace alone', async () => {
		const auth = authRuntime();
		const owner = await workspace(auth, 'owner@example.com', 'workspace-one');
		const other = await workspace(auth, 'other@example.com', 'workspace-two');
		const port = createMemberImportPort(auth);

		const outcomes = await write(
			port,
			owner,
			[
				row(1, { email: 'other@example.com', displayName: 'Other Owner' }),
				row(2, { email: 'fresh@example.com', displayName: 'Fresh One' }),
			],
			'create-only',
		);

		expect(outcomes).toEqual([
			{ row: 1, outcome: 'failed', reason: 'ACCOUNT_EXISTS' },
			{
				row: 2,
				outcome: 'created',
				recordRef: (await member(auth, owner, 'fresh@example.com')).accountId,
			},
		]);
		expect(
			(await members(auth, other.tenantId)).map((entry) => entry.email),
		).toEqual(['other@example.com']);
	});
});

describe('the members natural key', () => {
	/* The fold is this port's own: import.core compares whatever it answers, so
	   two spellings of one address are one key across the whole file rather than
	   only inside the batch they happen to share. */
	it('folds an address the way auth.core stores it', () => {
		const port = createMemberImportPort({} as AuthRuntime);
		expect(port.naturalKeyOf?.({ email: '  Ada@Example.COM  ' })).toBe(
			'ada@example.com',
		);
		expect(port.naturalKeyOf?.({ email: 'ＡＤＡ@example.com' })).toBe(
			'ada@example.com',
		);
		expect(port.naturalKeyOf?.({})).toBe('');
	});

	it('offers the port and its key on the module’s public entry', () => {
		expect(publicImportPort).toBe(createMemberImportPort);
		expect(publicPortKey).toBe(MEMBER_IMPORT_PORT_KEY);
	});
});

describe('users.core composition', () => {
	it('registers the members target when import.core is composed', () => {
		const registered: { moduleId: string; keys: string[] }[] = [];
		createServerComposition({
			auth: {} as AuthRuntime,
			capabilities: {
				get: (id: string) =>
					id === IMPORT_PORTS_CAPABILITY
						? {
								register: (moduleId: string, ports: readonly ImportPort[]) =>
									registered.push({
										moduleId,
										keys: ports.map((port) => port.key),
									}),
							}
						: null,
			},
		} as never);

		expect(registered).toEqual([
			{ moduleId: 'users.core', keys: [MEMBER_IMPORT_PORT_KEY] },
		]);
	});

	/* The capability is optional, so a deployment that leaves import.core out
	   still composes this module rather than failing at boot. */
	it('composes without the import capability', () => {
		const composition = createServerComposition({
			auth: {} as AuthRuntime,
			capabilities: { get: () => null },
		} as never);

		expect(composition.routes.length).toBeGreaterThan(0);
	});
});
