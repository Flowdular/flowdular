import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type {
	CliExtensionContext,
	CliExtensionResult,
} from '@flowdular/cli-protocol';
import type { DatabaseProvider } from '@flowdular/database';
import { MEMBER_SCOPES, OWNER_SCOPES } from '../src/acl/scopes.ts';
import { cliExtension } from '../src/cli/index.ts';
import {
	addWorkspaceMember,
	createWorkspace,
	listWorkspaces,
} from '../src/cli/provisioning.ts';
import {
	AuthService,
	type WorkspaceProvisionInput,
} from '../src/services/auth-service.ts';
import { AuthServiceError } from '../src/services/auth-service-error.ts';
import { call, fastHash, ORIGIN, testRuntime } from './helpers.ts';
import {
	authTestProvider,
	closeAuthTestDatabases,
	createAuthTestDatabase,
	type AuthTestDatabase,
} from './support/database.ts';

const PUBLIC_ORIGIN = 'https://erp.example';
const OPERATOR = 'cli:ada';

const open = new Set<AuthTestDatabase>();
const disposables = new Set<{ dispose(): Promise<void> }>();

afterEach(async () => {
	await Promise.all([...disposables].map((entry) => entry.dispose()));
	disposables.clear();
	await Promise.all([...open].map((database) => database.dispose()));
	open.clear();
	vi.unstubAllEnvs();
});

afterAll(closeAuthTestDatabases);

/* Every case runs against an embedded PostgreSQL, whose first boot alone
   outlasts the default per-test timeout. */
async function provisioning(): Promise<AuthService> {
	const database = await createAuthTestDatabase();
	open.add(database);
	return new AuthService(database.repository, {
		passwordHash: fastHash,
		publicBaseUrl: PUBLIC_ORIGIN,
	});
}

function workspaceInput(
	overrides: Partial<WorkspaceProvisionInput> = {},
): WorkspaceProvisionInput {
	return {
		name: 'Example Operations',
		slug: 'example-operations',
		ownerEmail: 'Ada.Owner@Example.COM',
		ownerDisplayName: 'Ada Owner',
		operator: OPERATOR,
		...overrides,
	};
}

function tokenOf(url: string | undefined): string {
	return new URL(url ?? '').searchParams.get('token')!;
}

async function refusal(
	action: Promise<unknown>,
): Promise<{ code: string; status: number; message: string }> {
	try {
		await action;
	} catch (error) {
		if (error instanceof AuthServiceError) {
			return {
				code: error.code,
				status: error.status,
				message: error.message,
			};
		}
		throw error;
	}
	throw new Error('The call was expected to be refused.');
}

describe('operator workspace provisioning', () => {
	it('creates the workspace, the owner and exactly the scopes a sign-up creates', async () => {
		const service = await provisioning();

		const created = await service.provisionWorkspace(workspaceInput());
		const signedUp = await service.signUp({
			email: 'other@example.com',
			password: 'correct horse battery staple',
			displayName: 'Other Owner',
			organizationName: 'Other Operations',
			organizationSlug: 'other-operations',
		});

		expect(created.workspace).toMatchObject({
			name: 'Example Operations',
			slug: 'example-operations',
		});
		expect(created.owner).toMatchObject({
			email: 'ada.owner@example.com',
			displayName: 'Ada Owner',
			role: 'owner',
		});
		expect([...created.owner.scopes].sort()).toEqual([...OWNER_SCOPES].sort());
		expect([...created.owner.scopes].sort()).toEqual(
			[...signedUp.principal.scopes].sort(),
		);
		expect(
			await service.listMembershipScopes(
				created.owner.accountId,
				created.workspace.tenantId,
			),
		).toHaveLength(OWNER_SCOPES.length);
	});

	it('issues a single-use setup link instead of inventing a password', async () => {
		const service = await provisioning();

		const created = await service.provisionWorkspace(workspaceInput());

		expect(created.credential.kind).toBe('password-setup-link');
		expect(created.credential.url).toMatch(
			new RegExp(`^${PUBLIC_ORIGIN}/auth/reset-password\\?token=`),
		);
		const token = tokenOf(created.credential.url);
		await service.completePasswordReset(token, 'owner chosen password');
		const session = await service.signIn({
			email: 'ada.owner@example.com',
			password: 'owner chosen password',
		});
		expect(session.principal.role).toBe('owner');
		expect(
			await refusal(service.completePasswordReset(token, 'another password')),
		).toMatchObject({ code: 'RESET_TOKEN_INVALID' });
	});

	it('keeps the setup token out of the audit trail and the result', async () => {
		const service = await provisioning();

		const created = await service.provisionWorkspace(workspaceInput());

		const token = tokenOf(created.credential.url);
		const audit = await service.queryAudit({
			tenantId: created.workspace.tenantId,
			limit: 100,
		});
		expect(JSON.stringify(audit)).not.toContain(token);
		expect(Object.keys(created.credential).sort()).toEqual([
			'expiresAt',
			'kind',
			'url',
		]);
	});

	it('uses a password the operator supplied and returns no link for it', async () => {
		const service = await provisioning();

		const created = await service.provisionWorkspace(
			workspaceInput({ password: 'operator chosen password' }),
		);

		expect(created.credential).toEqual({ kind: 'operator-password' });
		const session = await service.signIn({
			email: 'ada.owner@example.com',
			password: 'operator chosen password',
		});
		expect(session.principal.tenantId).toBe(created.workspace.tenantId);
	});

	it('records the operator in the audit trail of the new workspace', async () => {
		const service = await provisioning();

		const created = await service.provisionWorkspace(workspaceInput());

		const audit = await service.queryAudit({
			tenantId: created.workspace.tenantId,
			limit: 100,
		});
		const provisioned = audit.events.find(
			(event) => event.action === 'auth.workspace.provisioned',
		);
		expect(provisioned).toMatchObject({
			actorLabel: OPERATOR,
			actorAccountId: OPERATOR,
			subjectType: 'tenant',
			subjectId: created.workspace.tenantId,
			metadata: { slug: 'example-operations', name: 'Example Operations' },
		});
		expect(
			audit.events.find((event) => event.action === 'users.member.created'),
		).toMatchObject({
			actorLabel: OPERATOR,
			subjectId: created.owner.accountId,
			metadata: { email: 'ada.owner@example.com', role: 'owner' },
		});
	});

	it('plans the workspace, the owner and the owner scopes without writing', async () => {
		const service = await provisioning();

		const plan = await service.planWorkspaceProvision(workspaceInput());

		expect(plan).toEqual({
			workspace: { name: 'Example Operations', slug: 'example-operations' },
			owner: {
				email: 'ada.owner@example.com',
				displayName: 'Ada Owner',
				role: 'owner',
				scopes: OWNER_SCOPES,
			},
			credential: { kind: 'password-setup-link' },
			operator: OPERATOR,
		});
		expect(await service.listTenants()).toEqual([]);
		expect(await service.findAccountAccess('ada.owner@example.com')).toBeNull();
	});

	it('refuses a workspace id that is already taken', async () => {
		const service = await provisioning();
		await service.provisionWorkspace(workspaceInput());

		const refused = await refusal(
			service.provisionWorkspace(
				workspaceInput({ ownerEmail: 'second@example.com' }),
			),
		);

		expect(refused).toMatchObject({
			code: 'WORKSPACE_SLUG_TAKEN',
			status: 409,
		});
		expect(refused.message).toContain('example-operations');
		expect(await service.listTenants()).toHaveLength(1);
	});

	it('refuses an owner email that already has an account', async () => {
		const service = await provisioning();
		await service.provisionWorkspace(workspaceInput());

		const refused = await refusal(
			service.provisionWorkspace(
				workspaceInput({ slug: 'second-operations', name: 'Second Ops' }),
			),
		);

		expect(refused).toMatchObject({ code: 'ACCOUNT_EXISTS', status: 409 });
		expect(refused.message).toContain('ada.owner@example.com');
		expect(await service.listTenants()).toHaveLength(1);
	});

	it('applies the sign-up validators to the workspace id and the email', async () => {
		const service = await provisioning();

		expect(
			await refusal(service.provisionWorkspace(workspaceInput({ slug: 'AB' }))),
		).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
		expect(
			await refusal(
				service.provisionWorkspace(
					workspaceInput({ ownerEmail: 'not-an-address' }),
				),
			),
		).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
		expect(
			await refusal(
				service.provisionWorkspace(workspaceInput({ password: 'too short' })),
			),
		).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
		expect(await service.listTenants()).toEqual([]);
	});

	it('creates a workspace the owner signs into and uses on a scoped endpoint', async () => {
		const runtime = await testRuntime({ allowSignUp: false });
		disposables.add(runtime);

		const created =
			await runtime.authService.provisionWorkspace(workspaceInput());
		await runtime.authService.completePasswordReset(
			tokenOf(created.credential.url),
			'owner chosen password',
		);
		const session = await runtime.authService.signIn({
			email: 'ada.owner@example.com',
			password: 'owner chosen password',
		});
		const roles = await call(
			runtime,
			'/api/auth/roles',
			new Request(`${ORIGIN}/api/auth/roles`, {
				headers: { cookie: `${runtime.cookie.name}=${session.token}` },
			}),
		);

		expect(roles.status).toBe(200);
		const body = (await roles.json()) as {
			roles: { key: string }[];
			grantableScopes: string[];
		};
		expect(body.roles.map((role) => role.key)).toEqual(['owner', 'member']);
		expect(body.grantableScopes).toContain('auth.roles.manage');
	});
});

describe('operator member provisioning', () => {
	it('adds an existing account to a workspace with the role scopes', async () => {
		const service = await provisioning();
		const workspace = await service.provisionWorkspace(workspaceInput());
		const colleague = await service.signUp({
			email: 'colleague@example.com',
			password: 'correct horse battery staple',
			displayName: 'Cleo Colleague',
			organizationName: 'Colleague Operations',
			organizationSlug: 'colleague-operations',
		});

		const added = await service.provisionMember({
			workspace: 'example-operations',
			email: 'colleague@example.com',
			role: 'member',
			operator: OPERATOR,
		});

		expect(added).toMatchObject({
			action: 'membership',
			accountId: colleague.principal.accountId,
			invitationId: null,
			credential: { kind: 'existing-password' },
			role: 'member',
		});
		expect(added.credential.url).toBeUndefined();
		expect([...added.scopes].sort()).toEqual([...MEMBER_SCOPES].sort());
		const audit = await service.queryAudit({
			tenantId: workspace.workspace.tenantId,
			limit: 100,
		});
		expect(
			audit.events.filter((event) => event.action === 'users.member.created'),
		).toContainEqual(
			expect.objectContaining({
				actorLabel: OPERATOR,
				subjectId: colleague.principal.accountId,
				metadata: { email: 'colleague@example.com', role: 'member' },
			}),
		);
	});

	it('invites an unknown address and the invitation creates the account with that role', async () => {
		const service = await provisioning();
		const workspace = await service.provisionWorkspace(workspaceInput());

		const invited = await service.provisionMember({
			workspace: workspace.workspace.tenantId,
			email: 'Newcomer@Example.com',
			role: 'member',
			operator: OPERATOR,
		});

		expect(invited).toMatchObject({
			action: 'invitation',
			accountId: null,
			email: 'newcomer@example.com',
		});
		expect(invited.credential.kind).toBe('invitation-link');
		expect(invited.credential.url).toMatch(
			new RegExp(`^${PUBLIC_ORIGIN}/auth/accept-invitation\\?token=`),
		);
		await service.acceptTenantInvitation({
			token: tokenOf(invited.credential.url),
			displayName: 'New Comer',
			password: 'newcomer chosen password',
		});
		const session = await service.signIn({
			email: 'newcomer@example.com',
			password: 'newcomer chosen password',
		});
		expect(session.principal).toMatchObject({
			tenantId: workspace.workspace.tenantId,
			role: 'member',
		});
		const audit = await service.queryAudit({
			tenantId: workspace.workspace.tenantId,
			limit: 100,
		});
		expect(
			audit.events.find((event) => event.action === 'auth.invitation.created'),
		).toMatchObject({
			actorLabel: OPERATOR,
			subjectId: invited.invitationId,
			metadata: { role: 'member' },
		});
		expect(JSON.stringify(audit)).not.toContain(
			tokenOf(invited.credential.url),
		);
	});

	it('grants the owner role when the operator asks for it', async () => {
		const service = await provisioning();
		await service.provisionWorkspace(workspaceInput());
		await service.signUp({
			email: 'colleague@example.com',
			password: 'correct horse battery staple',
			displayName: 'Cleo Colleague',
			organizationName: 'Colleague Operations',
			organizationSlug: 'colleague-operations',
		});

		const added = await service.provisionMember({
			workspace: 'example-operations',
			email: 'colleague@example.com',
			role: 'owner',
			operator: OPERATOR,
		});

		expect([...added.scopes].sort()).toEqual([...OWNER_SCOPES].sort());
	});

	it('refuses an account that already belongs to the workspace', async () => {
		const service = await provisioning();
		await service.provisionWorkspace(workspaceInput());

		const refused = await refusal(
			service.provisionMember({
				workspace: 'example-operations',
				email: 'ada.owner@example.com',
				role: 'member',
				operator: OPERATOR,
			}),
		);

		expect(refused).toMatchObject({ code: 'MEMBER_EXISTS', status: 409 });
	});

	it('refuses an unknown workspace and an unknown role', async () => {
		const service = await provisioning();
		await service.provisionWorkspace(workspaceInput());

		expect(
			await refusal(
				service.provisionMember({
					workspace: 'no-such-workspace',
					email: 'newcomer@example.com',
					role: 'member',
					operator: OPERATOR,
				}),
			),
		).toMatchObject({ code: 'TENANT_NOT_FOUND', status: 404 });
		expect(
			await refusal(
				service.provisionMember({
					workspace: 'example-operations',
					email: 'newcomer@example.com',
					role: 'auditor',
					operator: OPERATOR,
				}),
			),
		).toMatchObject({ code: 'ROLE_NOT_FOUND', status: 404 });
	});

	/* A deployment composes no mail adapter, and the flag that enables the
	   in-memory one is refused in production. Both HTTP delivery paths are
	   therefore dead there, which is the gap these commands close. */
	it('issues both links with no mail adapter, where the HTTP paths cannot', async () => {
		const service = await provisioning();
		const created = await service.provisionWorkspace(workspaceInput());
		const owner = {
			accountId: created.owner.accountId,
			tenantId: created.workspace.tenantId,
			email: created.owner.email,
			role: 'owner',
			scopes: created.owner.scopes,
		};
		const resetRequests = async () =>
			(
				await service.queryAudit({
					tenantId: created.workspace.tenantId,
					limit: 100,
				})
			).events.filter(
				(event) => event.action === 'auth.password-reset.requested',
			).length;
		const before = await resetRequests();

		expect(
			await refusal(
				service.createTenantInvitation(owner, 'newcomer@example.com', 'member'),
			),
		).toMatchObject({ code: 'MAIL_NOT_CONFIGURED', status: 503 });
		await service.requestPasswordReset(created.owner.email);
		expect(await resetRequests()).toBe(before);

		expect(created.credential.url).toContain('/auth/reset-password?token=');
		const invited = await service.provisionMember({
			workspace: created.workspace.tenantId,
			email: 'newcomer@example.com',
			role: 'member',
			operator: OPERATOR,
		});
		expect(invited.credential.url).toContain('/auth/accept-invitation?token=');
	});

	it('plans the membership without writing it', async () => {
		const service = await provisioning();
		const workspace = await service.provisionWorkspace(workspaceInput());

		const plan = await service.planMemberProvision({
			workspace: 'example-operations',
			email: 'newcomer@example.com',
			role: 'member',
			operator: OPERATOR,
		});

		expect(plan).toMatchObject({
			action: 'invitation',
			account: null,
			email: 'newcomer@example.com',
			credential: { kind: 'invitation-link' },
			operator: OPERATOR,
		});
		expect(plan.role.scopes).toEqual(MEMBER_SCOPES);
		expect(
			await service.listTenantMembers(workspace.workspace.tenantId),
		).toHaveLength(1);
	});
});

describe('auth operator commands', () => {
	function context(
		databases: DatabaseProvider,
		flags: Record<string, string | boolean>,
		apply = false,
	): CliExtensionContext {
		return {
			workspaceRoot: process.cwd(),
			moduleRoot: process.cwd(),
			apply,
			flags: new Map(Object.entries(flags)),
			arguments: [],
			databases,
		};
	}

	const WORKSPACE_FLAGS = {
		name: 'Example Operations',
		'owner-email': 'ada.owner@example.com',
		'owner-name': 'Ada Owner',
		actor: 'ada',
	};

	interface WorkspaceListing {
		readonly total: number;
		readonly limit: number;
		readonly workspaces: readonly {
			readonly slug: string;
			readonly members: number;
			readonly owners: readonly { email: string; status: string }[];
		}[];
	}

	async function data<T>(result: Promise<CliExtensionResult>): Promise<T> {
		return (await result).data as T;
	}

	it('derives the workspace id from the name and writes nothing without --apply', async () => {
		vi.stubEnv('FD_AUTH_PUBLIC_ORIGIN', PUBLIC_ORIGIN);
		const databases = await authTestProvider();

		const preview = await data<{
			applied: boolean;
			workspace: { name: string; slug: string };
			owner: { scopes: string[] };
			credential: { kind: string };
			operator: string;
		}>(createWorkspace(context(databases, WORKSPACE_FLAGS)));

		expect(preview).toMatchObject({
			applied: false,
			workspace: { name: 'Example Operations', slug: 'example-operations' },
			credential: { kind: 'password-setup-link' },
			operator: 'cli:ada',
		});
		expect([...preview.owner.scopes].sort()).toEqual([...OWNER_SCOPES].sort());
		expect(
			await data<WorkspaceListing>(listWorkspaces(context(databases, {}))),
		).toMatchObject({ total: 0, workspaces: [] });
	});

	it('creates the workspace on --apply and lists it with its owner', async () => {
		vi.stubEnv('FD_AUTH_PUBLIC_ORIGIN', PUBLIC_ORIGIN);
		const databases = await authTestProvider();

		const applied = await createWorkspace(
			context(databases, WORKSPACE_FLAGS, true),
		);

		const created = applied.data as {
			applied: boolean;
			workspace: { tenantId: string; slug: string };
			credential: { kind: string; url: string };
		};
		expect(created.applied).toBe(true);
		expect(created.credential.url).toMatch(
			new RegExp(`^${PUBLIC_ORIGIN}/auth/reset-password\\?token=`),
		);
		expect(applied.warnings).toContain(
			'This link is shown once and cannot be recovered. Deliver it over a channel you trust.',
		);
		expect(
			await data<WorkspaceListing>(listWorkspaces(context(databases, {}))),
		).toMatchObject({
			total: 1,
			workspaces: [
				{
					slug: 'example-operations',
					members: 1,
					owners: [{ email: 'ada.owner@example.com', status: 'active' }],
				},
			],
		});
		const invited = await data<{
			action: string;
			email: string;
			role: string;
		}>(
			addWorkspaceMember(
				context(
					databases,
					{
						workspace: 'example-operations',
						email: 'newcomer@example.com',
						actor: 'ada',
					},
					true,
				),
			),
		);
		expect(invited).toMatchObject({
			action: 'invitation',
			email: 'newcomer@example.com',
			role: 'member',
		});
	});

	/* The runner refuses a command whose catalog entry and implementation
	   descriptor do not serialize identically, key order included. */
	it('declares every command identically in the catalog and the implementation', async () => {
		const catalog = JSON.parse(
			await readFile(
				new URL('../src/cli/commands.json', import.meta.url),
				'utf8',
			),
		) as {
			commands: { path: string[]; capability: Record<string, unknown> }[];
		};

		const key = (command: {
			path: readonly string[];
			capability: Record<string, unknown>;
		}) =>
			JSON.stringify({ path: command.path, capability: command.capability });
		expect(
			cliExtension.commands.map((command) =>
				key(command as unknown as Parameters<typeof key>[0]),
			),
		).toEqual(catalog.commands.map(key));
	});

	it('refuses a password given as a flag value and never echoes it', async () => {
		const databases = await authTestProvider();

		await expect(
			createWorkspace(
				context(databases, {
					...WORKSPACE_FLAGS,
					'password-env': 'correct horse battery staple',
				}),
			),
		).rejects.toThrow(
			'--password-env takes the NAME of an environment variable, never a password.',
		);
		await expect(
			createWorkspace(
				context(databases, {
					...WORKSPACE_FLAGS,
					'password-env': 'FD_OWNER_PASSWORD',
				}),
			),
		).rejects.toThrow(/named by --password-env is empty/);
	});

	it('reads an operator password from the named environment variable', async () => {
		vi.stubEnv('FD_OWNER_PASSWORD', 'operator chosen password');
		const databases = await authTestProvider();

		const preview = await data<{ credential: { kind: string } }>(
			createWorkspace(
				context(databases, {
					...WORKSPACE_FLAGS,
					'password-env': 'FD_OWNER_PASSWORD',
				}),
			),
		);

		expect(preview.credential).toEqual({ kind: 'operator-password' });
	});
});
