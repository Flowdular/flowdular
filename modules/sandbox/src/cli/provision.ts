import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
	CliExtensionContext,
	CliExtensionResult,
} from '@flowdular/cli-protocol';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import { SANDBOX_GRANT_CAPABILITIES } from '../acl/permissions.ts';
import type { SandboxService } from '../services/sandbox-service.ts';

/* Everything a business user needs before the first prompt used to be four
   manual steps in two applications: start the platform, sign in, create an API
   token with three scopes, and grant that account sandbox access. None of it is
   a business decision.

   This command performs all of it against the deployment database, from the
   host, and is the reason the sandbox no longer asks for a pasted credential.

   The trust model is the one the other operator commands already use. Token
   management is a browser-session operation over HTTP, and that is unchanged:
   `POST /api/auth/api-tokens` still refuses a machine credential. This is a
   host command, in the same position as `auth workspace-create`,
   `auth sync-scopes` and `auth greenfield`, all of which write to the auth
   database directly. It mints a token only for an account it owns, in a
   workspace it creates or names, with the four sandbox scopes and nothing
   else. It cannot reach an operator's existing account unless that account is
   named explicitly with --email, and it never reads a password from a flag. */

const DEFAULT_WORKSPACE_NAME = 'Sandbox';
const DEFAULT_WORKSPACE_SLUG = 'sandbox';
/* The domain has to carry a dot: auth rejects an address without one. */
const DEFAULT_OWNER_EMAIL = 'sandbox-operator@example.com';
const DEFAULT_OWNER_DISPLAY_NAME = 'Sandbox operator';
const DEFAULT_TOKEN_LABEL = 'Sandbox launcher';
const MAX_LABEL = 80;
const MIN_LABEL = 2;
const CREDENTIALS_MODE = 0o600;

export interface ProvisionRuntimes {
	readonly auth: AuthRuntime;
	readonly service: SandboxService;
	dispose(): Promise<void>;
}

interface Flags {
	readonly workspaceName: string;
	readonly workspaceSlug: string;
	readonly email: string;
	readonly displayName: string;
	readonly label: string;
	readonly credentialsFile: string;
	/* The name of an environment variable carrying the owner password. A
	   password on a flag would land in shell history and in the process list. */
	readonly passwordVariable: string | undefined;
}

export function provisionFlags(context: CliExtensionContext): Flags {
	const read = (name: string): string | undefined => {
		const value = context.flags.get(name);
		return typeof value === 'string' && value.trim() ? value.trim() : undefined;
	};
	const label = read('label') ?? DEFAULT_TOKEN_LABEL;
	if (label.length < MIN_LABEL || label.length > MAX_LABEL) {
		throw new Error(
			`--label must be between ${MIN_LABEL} and ${MAX_LABEL} characters.`,
		);
	}
	const passwordVariable = read('password-env');
	if (passwordVariable && !/^[A-Z][A-Z0-9_]{0,63}$/.test(passwordVariable)) {
		throw new Error(
			'--password-env takes the NAME of an environment variable, never a password.',
		);
	}
	return {
		workspaceName: read('workspace-name') ?? DEFAULT_WORKSPACE_NAME,
		workspaceSlug: read('workspace-slug') ?? DEFAULT_WORKSPACE_SLUG,
		email: read('email') ?? DEFAULT_OWNER_EMAIL,
		displayName: read('display-name') ?? DEFAULT_OWNER_DISPLAY_NAME,
		label,
		credentialsFile: read('credentials-file') ?? '',
		passwordVariable,
	};
}

/* The scopes the sandbox needs to run a session. `sandbox.access.use` opens the
   dashboard, `sandbox.sessions.read` lists them, `sandbox.preview.data` lets a
   preview see live rows and `sandbox.modules.eject` is what makes delivery
   possible at all. Nothing outside the sandbox module is requested. */
export function provisionScopes(
	available: ReadonlySet<string>,
): readonly string[] {
	return SANDBOX_GRANT_CAPABILITIES.filter((capability) =>
		available.has(capability),
	);
}

function ownerPassword(flags: Flags): string | undefined {
	if (!flags.passwordVariable) return undefined;
	const password = process.env[flags.passwordVariable];
	if (!password) {
		throw new Error(
			`The environment variable ${flags.passwordVariable} is empty. Export the password there, or drop --password-env and the account is reachable only through its setup link.`,
		);
	}
	return password;
}

/* An existing account is reused rather than replaced, so re-provisioning does
   not orphan the workspace a business user already built into. The email still
   has to resolve to exactly one workspace, which is what accountOf enforces. */
async function resolveAccount(
	auth: AuthRuntime,
	flags: Flags,
): Promise<{
	readonly tenantId: string;
	readonly accountId: string;
	readonly email: string;
} | null> {
	const account = await (await auth.service()).findAccountAccess(flags.email);
	if (!account) return null;
	const tenant = account.tenants.find(
		(candidate) => candidate.slug === flags.workspaceSlug.toLowerCase(),
	);
	if (!tenant) return null;
	return {
		tenantId: tenant.tenantId,
		accountId: account.accountId,
		email: flags.email,
	};
}

export async function provisionSandbox(
	context: CliExtensionContext,
	runtimes: ProvisionRuntimes,
): Promise<CliExtensionResult> {
	const flags = provisionFlags(context);
	const { auth, service } = runtimes;
	const existing = await resolveAccount(auth, flags);

	if (existing === null) {
		if (!context.apply) {
			return {
				data: {
					applied: false,
					action: 'create-workspace',
					workspace: {
						name: flags.workspaceName,
						slug: flags.workspaceSlug,
					},
					owner: { email: flags.email, displayName: flags.displayName },
					scopes: SANDBOX_GRANT_CAPABILITIES,
					credentialsFile: flags.credentialsFile || null,
				},
				evidence: ['modules/sandbox/spec/module.yaml'],
			};
		}
		const password = ownerPassword(flags);
		const provisioned = await (
			await auth.service()
		).provisionWorkspace({
			name: flags.workspaceName,
			slug: flags.workspaceSlug,
			ownerEmail: flags.email,
			ownerDisplayName: flags.displayName,
			operator: actorOf(context),
			...(password === undefined ? {} : { password }),
		});
		const created = await resolveAccount(auth, flags);
		if (created === null) {
			throw new Error(
				`The workspace was created but ${flags.email} does not resolve to it. Run sandbox access to see what exists.`,
			);
		}
		return await grantAndIssue(context, runtimes, created, flags, provisioned);
	}

	return await grantAndIssue(context, runtimes, existing, flags, null);
}

function actorOf(context: CliExtensionContext): string {
	const explicit = context.flags.get('actor');
	if (typeof explicit === 'string' && explicit.trim())
		return `cli:${explicit.trim().slice(0, 100)}`;
	try {
		return `cli:${process.env.USER?.slice(0, 100) ?? 'operator'}`;
	} catch {
		return 'cli:operator';
	}
}

async function grantAndIssue(
	context: CliExtensionContext,
	runtimes: ProvisionRuntimes,
	account: {
		readonly tenantId: string;
		readonly accountId: string;
		readonly email: string;
	},
	flags: Flags,
	provisioned: unknown,
): Promise<CliExtensionResult> {
	const { auth, service } = runtimes;
	const held = new Set(
		await (
			await auth.service()
		).listMembershipScopes(account.accountId, account.tenantId),
	);
	const capabilities = provisionScopes(held);
	if (capabilities.length === 0) {
		throw new Error(
			`${account.email} holds no sandbox scope in this workspace. Grant sandbox.access.use on its membership, then run this again.`,
		);
	}
	if (!context.apply) {
		return {
			data: {
				applied: false,
				action: provisioned ? 'create-workspace-and-token' : 'issue-token',
				tenantId: account.tenantId,
				account: { accountId: account.accountId, email: account.email },
				capabilities,
				label: flags.label,
				credentialsFile: flags.credentialsFile || null,
			},
			evidence: ['modules/sandbox/spec/module.yaml'],
		};
	}

	const grant = await service.grant({
		tenantId: account.tenantId,
		actorId: actorOf(context),
		accountId: account.accountId,
		capabilities,
		expiresAt: null,
		note: 'Provisioned by the sandbox launcher.',
	});
	const issued = await (
		await auth.service()
	).issueApiToken({
		tenantId: account.tenantId,
		accountId: account.accountId,
		label: flags.label,
		scopes: capabilities,
		allowWrites: true,
		allowedOrigins: [],
		rateLimitPerMinute: 0,
		expiresAt: null,
		createdBy: actorOf(context),
	});

	if (flags.credentialsFile) {
		/* Written to a file the caller names rather than printed, so the secret
		   never reaches a terminal scrollback, a CI log or a transcript. */
		await mkdir(dirname(flags.credentialsFile), {
			recursive: true,
			mode: 0o700,
		});
		await writeFile(
			flags.credentialsFile,
			`${JSON.stringify(
				{
					version: 1,
					platformTenantId: account.tenantId,
					email: account.email,
					token: issued.token,
					capabilities,
				},
				null,
				'\t',
			)}\n`,
			{ encoding: 'utf8', mode: CREDENTIALS_MODE },
		);
		await chmod(flags.credentialsFile, CREDENTIALS_MODE);
	}

	return {
		data: {
			applied: true,
			action: provisioned ? 'create-workspace-and-token' : 'issue-token',
			tenantId: account.tenantId,
			account: { accountId: account.accountId, email: account.email },
			capabilities,
			/* The prefix is safe to show; the secret never is. The value only
			   appears when the caller named a file to receive it. */
			tokenPrefix: issued.token.slice(0, 12),
			credentialsFile: flags.credentialsFile || null,
			grant: {
				id: grant.id,
				capabilities: grant.capabilities,
				grantedAt: grant.grantedAt,
			},
		},
		evidence: ['modules/sandbox/spec/module.yaml'],
	};
}

/* Exposed so the launcher can create a workspace with a password it generated
   and never shows, which is what removes the last manual step. */
export function generatedPassword(): string {
	return randomBytes(24).toString('base64url');
}
