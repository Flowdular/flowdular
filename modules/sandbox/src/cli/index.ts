import { userInfo } from 'node:os';
import {
	defineCliExtension,
	type CliExtensionContext,
} from '@coreloom/cli-protocol';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
	type AuthRuntime,
} from '@coreloom/module-auth/server';
import { SANDBOX_GRANT_CAPABILITIES } from '../acl/permissions.ts';
import type { SandboxGrantCapability } from '../domain/types.ts';
import {
	createSandboxRuntime,
	sandboxRuntimeOptionsFromEnvironment,
} from '../server/runtime.ts';
import type { SandboxService } from '../services/sandbox-service.ts';

interface ResolvedRuntimes {
	readonly auth: AuthRuntime;
	readonly service: SandboxService;
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

function runtimes(context: CliExtensionContext): ResolvedRuntimes {
	const auth = createAuthRuntime(
		authRuntimeOptionsFromEnvironment(process.env, context.workspaceRoot),
	);
	const sandbox = createSandboxRuntime(
		sandboxRuntimeOptionsFromEnvironment(process.env, context.workspaceRoot),
	);
	return { auth, service: sandbox.service(auth) };
}

function tenantOf(auth: AuthRuntime, reference: string) {
	const tenant = auth.service().findTenant(reference);
	if (!tenant) {
		throw new Error(`No workspace matches "${reference}".`);
	}
	return tenant;
}

function accountOf(auth: AuthRuntime, email: string, tenantReference?: string) {
	const account = auth.service().findAccountAccess(email);
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

function sessionOf(service: SandboxService, tenantId: string, id: string) {
	const session = service.findSession(tenantId, id);
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
			execute: (context) => {
				const { auth, service } = runtimes(context);
				const tenant = tenantOf(auth, required(context, 'tenant'));
				return {
					data: {
						tenant,
						grants: service.listGrants(tenant.tenantId),
						candidates: service.listCandidates(tenant.tenantId),
					},
					evidence: ['.coreloom/data/sandbox.db'],
				};
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
			execute: (context) => {
				const { auth, service } = runtimes(context);
				const email = required(context, 'email');
				const { account, membership } = accountOf(
					auth,
					email,
					flag(context, 'tenant'),
				);
				const available = new Set(
					auth
						.service()
						.listMembershipScopes(account.accountId, membership.tenantId),
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
						grant: service.grant({
							tenantId: membership.tenantId,
							actorId: actorOf(context),
							accountId: account.accountId,
							capabilities: requested,
							expiresAt,
							note: flag(context, 'note') ?? null,
						}),
					},
					evidence: ['.coreloom/data/sandbox.db'],
				};
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
			execute: (context) => {
				const { auth, service } = runtimes(context);
				const email = required(context, 'email');
				const { account, membership } = accountOf(
					auth,
					email,
					flag(context, 'tenant'),
				);
				const current = service
					.listGrants(membership.tenantId)
					.find((grant) => grant.accountId === account.accountId);
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
						grant: service.revoke(
							membership.tenantId,
							account.accountId,
							actorOf(context),
						),
					},
					evidence: ['.coreloom/data/sandbox.db'],
				};
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
			execute: (context) => {
				const { auth, service } = runtimes(context);
				const tenant = tenantOf(auth, required(context, 'tenant'));
				return {
					data: {
						tenant,
						sessions: service.listSessions(tenant.tenantId, 50),
					},
					evidence: ['.coreloom/data/sandbox.db'],
				};
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
			execute: (context) => {
				const { auth, service } = runtimes(context);
				const tenant = tenantOf(auth, required(context, 'tenant'));
				const session = sessionOf(
					service,
					tenant.tenantId,
					required(context, 'id'),
				);
				if (!context.apply) {
					return { data: { applied: false, tenant, session, to: 'archived' } };
				}
				return {
					data: {
						applied: true,
						session: service.archiveSession(
							tenant.tenantId,
							session.id,
							actorOf(context),
						),
					},
					evidence: ['.coreloom/data/sandbox.db'],
				};
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
			execute: (context) => {
				const { auth, service } = runtimes(context);
				const tenant = tenantOf(auth, required(context, 'tenant'));
				const session = sessionOf(
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
						session: service.deleteSession(
							tenant.tenantId,
							session.id,
							actorOf(context),
						),
					},
					evidence: ['.coreloom/data/sandbox.db'],
				};
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
			execute: (context) => {
				const { auth, service } = runtimes(context);
				const tenant = tenantOf(auth, required(context, 'tenant'));
				const events = service.listAuditEvents(tenant.tenantId, 250);
				return {
					data: {
						tenant,
						valid: service.verifyAuditChain(tenant.tenantId),
						eventsInspected: events.length,
						latestSequence: events[0]?.sequence ?? 0,
					},
					evidence: ['.coreloom/data/sandbox.db'],
				};
			},
		},
	],
});

export default cliExtension;
