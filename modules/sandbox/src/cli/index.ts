import { userInfo } from 'node:os';
import {
	defineCliExtension,
	type CliExtensionContext,
} from '@flowdular/cli-protocol';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { SANDBOX_GRANT_CAPABILITIES } from '../acl/permissions.ts';
import type { SandboxGrantCapability } from '../domain/types.ts';
import {
	createSandboxRuntime,
	sandboxSettingsFromEnvironment,
} from '../server/runtime.ts';
import type { SandboxService } from '../services/sandbox-service.ts';

interface ResolvedRuntimes {
	readonly auth: AuthRuntime;
	readonly service: SandboxService;
	dispose(): Promise<void>;
}

function flag(context: CliExtensionContext, name: string): string | undefined {
	const value = context.flags.get(name);
	return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function required(context: CliExtensionContext, name: string): string {
	const value = flag(context, name);
	if (!value) throw new Error(`--${name} <value> is required.`);
	return value;
}

function actorOf(context: CliExtensionContext): string {
	const explicit = flag(context, 'actor');
	if (explicit) return `cli:${explicit.slice(0, 100)}`;
	try {
		return `cli:${userInfo().username.slice(0, 100)}`;
	} catch {
		return 'cli:operator';
	}
}

/* The operator commands read the same deployment database the platform does;
   there is no module-owned file to open. The runner owns the provider and a
   module owns no driver, so it arrives on the context. */
async function runtimes(
	context: CliExtensionContext,
): Promise<ResolvedRuntimes> {
	const databases = context.databases;
	if (!databases) {
		throw new Error(
			'sandbox.core CLI commands read the deployment database, and this workspace has none configured.',
		);
	}
	const auth = createAuthRuntime({
		...authRuntimeOptionsFromEnvironment(process.env, context.workspaceRoot),
		databases,
	});
	const sandbox = createSandboxRuntime({
		...sandboxSettingsFromEnvironment(process.env),
		databases,
		purpose: 'runtime',
	});
	try {
		/* The provider belongs to the runner; only the lease this runtime took is
		   released here. */
		return {
			auth,
			service: await sandbox.service(auth),
			dispose: sandbox.dispose,
		};
	} catch (error) {
		await sandbox.dispose();
		throw error;
	}
}

async function tenantOf(auth: AuthRuntime, reference: string) {
	const tenant = await (await auth.service()).findTenant(reference);
	if (!tenant) {
		throw new Error(`No workspace matches "${reference}".`);
	}
	return tenant;
}

async function accountOf(
	auth: AuthRuntime,
	email: string,
	tenantReference?: string,
) {
	const account = await (await auth.service()).findAccountAccess(email);
	if (!account) throw new Error(`No account exists for ${email}.`);
	const membership = tenantReference
		? account.tenants.find(
				(tenant) =>
					tenant.tenantId === tenantReference ||
					tenant.slug === tenantReference.toLowerCase(),
			)
		: account.tenants.length === 1
			? account.tenants[0]
			: undefined;
	if (!membership) {
		throw new Error(
			account.tenants.length === 1
				? `${email} is not a member of "${tenantReference}".`
				: `--tenant <slug|id> is required. ${email} belongs to: ${account.tenants
						.map((tenant) => tenant.slug)
						.join(', ')}`,
		);
	}
	return { account, membership };
}

async function sessionOf(
	service: SandboxService,
	tenantId: string,
	id: string,
) {
	const session = await service.findSession(tenantId, id);
	if (!session)
		throw new Error(`No sandbox session ${id} exists in this tenant.`);
	return session;
}

function requestedCapabilities(
	context: CliExtensionContext,
): readonly string[] | undefined {
	const value = flag(context, 'capabilities');
	if (!value) return undefined;
	return value
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) =>
			entry.startsWith('sandbox.') ? entry : `sandbox.${entry}`,
		);
}

function expiryOf(context: CliExtensionContext): number | null {
	const value = flag(context, 'expires-days');
	if (!value) return null;
	const days = Number(value);
	if (!Number.isFinite(days) || days <= 0 || days > 365) {
		throw new Error('--expires-days must be a number between 1 and 365.');
	}
	return Date.now() + Math.round(days * 24 * 60 * 60 * 1000);
}

export const cliExtension = defineCliExtension({
	protocolVersion: 1,
	moduleId: 'sandbox.core',
	commands: [
		{
			path: ['sandbox', 'access'],
			capability: {
				id: 'sandbox.access.list',
				version: 1,
				summary: 'List sandbox access grants and eligible members of a tenant.',
				risk: 'read',
				requiresApprovedSpec: false,
				supportsDryRun: false,
			},
			execute: async (context) => {
				const resolved = await runtimes(context);
				try {
					const { auth, service } = resolved;
					const tenant = await tenantOf(auth, required(context, 'tenant'));
					return {
						data: {
							tenant,
							grants: await service.listGrants(tenant.tenantId),
							candidates: await service.listCandidates(tenant.tenantId),
						},
						evidence: ['modules/sandbox/spec/module.yaml'],
					};
				} finally {
					await resolved.dispose();
				}
			},
		},
		{
			path: ['sandbox', 'grant'],
			capability: {
				id: 'sandbox.access.grant',
				version: 1,
				summary: 'Grant sandbox access to an existing account of a tenant.',
				risk: 'process',
				requiresApprovedSpec: false,
				supportsDryRun: true,
			},
			execute: async (context) => {
				const resolved = await runtimes(context);
				try {
					const { auth, service } = resolved;
					const email = required(context, 'email');
					const { account, membership } = await accountOf(
						auth,
						email,
						flag(context, 'tenant'),
					);
					const available = new Set(
						await (
							await auth.service()
						).listMembershipScopes(account.accountId, membership.tenantId),
					);
					const requested =
						requestedCapabilities(context) ??
						SANDBOX_GRANT_CAPABILITIES.filter((capability) =>
							available.has(capability),
						);
					const capabilities = SANDBOX_GRANT_CAPABILITIES.filter(
						(capability) =>
							available.has(capability) && requested.includes(capability),
					) as readonly SandboxGrantCapability[];
					const expiresAt = expiryOf(context);
					if (!context.apply) {
						return {
							data: {
								applied: false,
								tenant: membership,
								account: {
									accountId: account.accountId,
									email: account.email,
									displayName: account.displayName,
								},
								capabilities,
								expiresAt,
							},
							warnings:
								capabilities.length === 0
									? [
											'The account holds no sandbox scope. Grant the scope on its membership first.',
										]
									: [],
						};
					}
					return {
						data: {
							applied: true,
							grant: await service.grant({
								tenantId: membership.tenantId,
								actorId: actorOf(context),
								accountId: account.accountId,
								capabilities: requested,
								expiresAt,
								note: flag(context, 'note') ?? null,
							}),
						},
						evidence: ['modules/sandbox/spec/module.yaml'],
					};
				} finally {
					await resolved.dispose();
				}
			},
		},
		{
			path: ['sandbox', 'revoke'],
			capability: {
				id: 'sandbox.access.revoke',
				version: 1,
				summary: 'Revoke sandbox access for an account of a tenant.',
				risk: 'process',
				requiresApprovedSpec: false,
				supportsDryRun: true,
			},
			execute: async (context) => {
				const resolved = await runtimes(context);
				try {
					const { auth, service } = resolved;
					const email = required(context, 'email');
					const { account, membership } = await accountOf(
						auth,
						email,
						flag(context, 'tenant'),
					);
					const current = (await service.listGrants(membership.tenantId)).find(
						(grant) => grant.accountId === account.accountId,
					);
					if (!current) throw new Error(`${email} has no sandbox grant.`);
					if (!context.apply) {
						return {
							data: {
								applied: false,
								tenant: membership,
								grant: current,
							},
						};
					}
					return {
						data: {
							applied: true,
							grant: await service.revoke(
								membership.tenantId,
								account.accountId,
								actorOf(context),
							),
						},
						evidence: ['modules/sandbox/spec/module.yaml'],
					};
				} finally {
					await resolved.dispose();
				}
			},
		},
		{
			path: ['sandbox', 'sessions'],
			capability: {
				id: 'sandbox.sessions.list',
				version: 1,
				summary: 'List recorded sandbox sessions of a tenant.',
				risk: 'read',
				requiresApprovedSpec: false,
				supportsDryRun: false,
			},
			execute: async (context) => {
				const resolved = await runtimes(context);
				try {
					const { auth, service } = resolved;
					const tenant = await tenantOf(auth, required(context, 'tenant'));
					return {
						data: {
							tenant,
							sessions: await service.listSessions(tenant.tenantId, 50),
						},
						evidence: ['modules/sandbox/spec/module.yaml'],
					};
				} finally {
					await resolved.dispose();
				}
			},
		},
		{
			path: ['sandbox', 'session-archive'],
			capability: {
				id: 'sandbox.sessions.archive',
				version: 1,
				summary: 'Archive a recorded sandbox session of a tenant.',
				risk: 'process',
				requiresApprovedSpec: false,
				supportsDryRun: true,
			},
			execute: async (context) => {
				const resolved = await runtimes(context);
				try {
					const { auth, service } = resolved;
					const tenant = await tenantOf(auth, required(context, 'tenant'));
					const session = await sessionOf(
						service,
						tenant.tenantId,
						required(context, 'id'),
					);
					if (!context.apply) {
						return {
							data: { applied: false, tenant, session, to: 'archived' },
						};
					}
					return {
						data: {
							applied: true,
							session: await service.archiveSession(
								tenant.tenantId,
								session.id,
								actorOf(context),
							),
						},
						evidence: ['modules/sandbox/spec/module.yaml'],
					};
				} finally {
					await resolved.dispose();
				}
			},
		},
		{
			path: ['sandbox', 'session-delete'],
			capability: {
				id: 'sandbox.sessions.delete',
				version: 1,
				summary:
					'Mark a recorded sandbox session deleted; the sandbox application removes its workspace.',
				risk: 'process',
				requiresApprovedSpec: false,
				supportsDryRun: true,
			},
			execute: async (context) => {
				const resolved = await runtimes(context);
				try {
					const { auth, service } = resolved;
					const tenant = await tenantOf(auth, required(context, 'tenant'));
					const session = await sessionOf(
						service,
						tenant.tenantId,
						required(context, 'id'),
					);
					if (!context.apply) {
						return { data: { applied: false, tenant, session, to: 'deleted' } };
					}
					return {
						data: {
							applied: true,
							session: await service.deleteSession(
								tenant.tenantId,
								session.id,
								actorOf(context),
							),
						},
						evidence: ['modules/sandbox/spec/module.yaml'],
					};
				} finally {
					await resolved.dispose();
				}
			},
		},
		{
			path: ['sandbox', 'audit-verify'],
			capability: {
				id: 'sandbox.audit.verify',
				version: 1,
				summary: 'Verify the local tenant-scoped sandbox audit hash chain.',
				risk: 'read',
				requiresApprovedSpec: false,
				supportsDryRun: false,
				localOnly: true,
			},
			execute: async (context) => {
				const resolved = await runtimes(context);
				try {
					const { auth, service } = resolved;
					const tenant = await tenantOf(auth, required(context, 'tenant'));
					const events = await service.listAuditEvents(tenant.tenantId, 250);
					return {
						data: {
							tenant,
							valid: await service.verifyAuditChain(tenant.tenantId),
							eventsInspected: events.length,
							latestSequence: events[0]?.sequence ?? 0,
						},
						evidence: ['modules/sandbox/spec/module.yaml'],
					};
				} finally {
					await resolved.dispose();
				}
			},
		},
	],
});

export default cliExtension;
