import { userInfo } from 'node:os';
import type {
	CliExtensionContext,
	CliExtensionResult,
} from '@flowdular/cli-protocol';
import { slugifyWorkspaceName } from '../client/slug.ts';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
	type AuthRuntime,
} from '../server/runtime.ts';
import type {
	MemberProvisionInput,
	WorkspaceProvisionInput,
} from '../services/auth-service.ts';

const SPEC_EVIDENCE = 'modules/auth/spec/module.yaml';
const SCOPE_EVIDENCE = 'modules/auth/src/acl/scopes.ts';
const DEFAULT_WORKSPACE_PAGE = 25;
const MAX_WORKSPACE_PAGE = 200;

function flag(context: CliExtensionContext, name: string): string | undefined {
	const value = context.flags.get(name);
	return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function required(context: CliExtensionContext, name: string): string {
	const value = flag(context, name);
	if (!value) throw new Error(`--${name} <value> is required.`);
	return value;
}

/* Who the audit trail records. An owner created by an operator command is the
   highest privilege a workspace has, so the row names the shell that made it. */
function operatorOf(context: CliExtensionContext): string {
	const explicit = flag(context, 'actor');
	if (explicit) return `cli:${explicit.slice(0, 100)}`;
	try {
		return `cli:${userInfo().username.slice(0, 100)}`;
	} catch {
		return 'cli:operator';
	}
}

/* A password never arrives as a flag value: flags land in shell history and in
   the process list of every other user on the host. The flag carries the name
   of an environment variable, and a value that does not look like one is
   refused without being echoed back. */
function operatorPassword(context: CliExtensionContext): string | undefined {
	const variable = flag(context, 'password-env');
	if (!variable) return undefined;
	if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(variable)) {
		throw new Error(
			'--password-env takes the NAME of an environment variable, never a password.',
		);
	}
	const password = process.env[variable];
	if (!password) {
		throw new Error(
			'The environment variable named by --password-env is empty. Export the password there, or drop the flag to issue a one-time setup link instead.',
		);
	}
	return password;
}

function pageSize(context: CliExtensionContext): number {
	const value = flag(context, 'limit');
	if (!value) return DEFAULT_WORKSPACE_PAGE;
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WORKSPACE_PAGE) {
		throw new Error(
			`--limit must be a whole number from 1 to ${MAX_WORKSPACE_PAGE}.`,
		);
	}
	return limit;
}

/* These commands write to the deployment database through the platform-owned
   provider on the context. The runner owns it: this releases only the leases
   the runtime took. */
async function withAuth<T>(
	context: CliExtensionContext,
	run: (auth: AuthRuntime) => Promise<T>,
): Promise<T> {
	const databases = context.databases;
	if (!databases) {
		throw new Error(
			'auth.core operator commands use the deployment database, and this workspace has none configured.',
		);
	}
	const auth = createAuthRuntime({
		...authRuntimeOptionsFromEnvironment(process.env, context.workspaceRoot),
		databases,
	});
	try {
		return await run(auth);
	} finally {
		await auth.dispose();
	}
}

/* A link is the whole point of the command that emitted it, so it is printed.
   Saying so is what keeps an operator from expecting to read it again. */
function linkWarnings(auth: AuthRuntime, kind: string): readonly string[] {
	if (kind !== 'password-setup-link' && kind !== 'invitation-link') return [];
	return [
		'This link is shown once and cannot be recovered. Deliver it over a channel you trust.',
		...(auth.publicBaseUrl
			? []
			: [
					'FD_AUTH_PUBLIC_ORIGIN is not configured, so the link points at http://localhost. Set it and issue a new link from the deployment origin.',
				]),
	];
}

export async function listWorkspaces(
	context: CliExtensionContext,
): Promise<CliExtensionResult> {
	const limit = pageSize(context);
	return withAuth(context, async (auth) => {
		const service = await auth.service();
		const tenants = await service.listTenants();
		const page = tenants.slice(0, limit);
		const workspaces = [];
		for (const tenant of page) {
			const members = await service.listTenantMembers(tenant.tenantId);
			workspaces.push({
				...tenant,
				members: members.length,
				owners: members
					.filter((member) => member.role === 'owner')
					.map((member) => ({
						accountId: member.accountId,
						email: member.email,
						status: member.status,
					})),
			});
		}
		return {
			data: { total: tenants.length, limit, workspaces },
			evidence: [SPEC_EVIDENCE],
		};
	});
}

export async function createWorkspace(
	context: CliExtensionContext,
): Promise<CliExtensionResult> {
	const name = required(context, 'name');
	const password = operatorPassword(context);
	const input: WorkspaceProvisionInput = {
		name,
		slug: flag(context, 'slug') ?? slugifyWorkspaceName(name),
		ownerEmail: required(context, 'owner-email'),
		ownerDisplayName: required(context, 'owner-name'),
		operator: operatorOf(context),
		...(password ? { password } : {}),
	};
	return withAuth(context, async (auth) => {
		const service = await auth.service();
		if (!context.apply) {
			const plan = await service.planWorkspaceProvision(input);
			return {
				data: { applied: false, ...plan },
				evidence: [SPEC_EVIDENCE, SCOPE_EVIDENCE],
			};
		}
		const created = await service.provisionWorkspace(input);
		return {
			data: { applied: true, ...created },
			evidence: [SPEC_EVIDENCE, SCOPE_EVIDENCE],
			warnings: linkWarnings(auth, created.credential.kind),
		};
	});
}

export async function addWorkspaceMember(
	context: CliExtensionContext,
): Promise<CliExtensionResult> {
	const input: MemberProvisionInput = {
		workspace: required(context, 'workspace'),
		email: required(context, 'email'),
		role: flag(context, 'role') ?? 'member',
		operator: operatorOf(context),
	};
	return withAuth(context, async (auth) => {
		const service = await auth.service();
		if (!context.apply) {
			const plan = await service.planMemberProvision(input);
			return {
				data: {
					applied: false,
					workspace: plan.workspace,
					email: plan.email,
					action: plan.action,
					account: plan.account,
					role: { key: plan.role.key, scopes: plan.role.scopes },
					credential: plan.credential,
					operator: plan.operator,
				},
				evidence: [SPEC_EVIDENCE],
			};
		}
		const provisioned = await service.provisionMember(input);
		return {
			data: { applied: true, ...provisioned },
			evidence: [SPEC_EVIDENCE],
			warnings: linkWarnings(auth, provisioned.credential.kind),
		};
	});
}
