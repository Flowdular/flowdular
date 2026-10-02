import { randomBytes } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { flowdularStateDirectory } from '@flowdular/kernel/runtime-config';
import { SANDBOX_GRANT_CAPABILITIES } from '../acl/permissions.ts';

export interface ProvisionInboxOptions {
	readonly workspaceRoot: string;
	readonly auth: ProvisionAuth;
	readonly grant: (input: ProvisionGrantInput) => Promise<ProvisionGrant>;
	readonly listGrants: (tenantId: string) => Promise<readonly unknown[]>;
	readonly log?: (line: string) => void;
}

/* Only the two shapes this file needs, so the module does not depend on the
   whole auth service surface to hand a credential to the sandbox launcher. */
export interface ProvisionAuth {
	service(): Promise<{
		findAccountAccess(email: string): Promise<{
			accountId: string;
			tenants: readonly { readonly tenantId: string; readonly slug: string }[];
		} | null>;
		listMembershipScopes(
			accountId: string,
			tenantId: string,
		): Promise<readonly string[]>;
		provisionWorkspace(input: {
			name: string;
			slug: string;
			ownerEmail: string;
			ownerDisplayName: string;
			operator: string;
			password?: string;
		}): Promise<unknown>;
		issueApiToken(input: {
			tenantId: string;
			accountId: string;
			label: string;
			scopes: readonly string[];
			allowWrites: boolean;
			allowedOrigins: readonly string[];
			rateLimitPerMinute: number;
			expiresAt: number | null;
			createdBy: string;
		}): Promise<{ readonly token: string }>;
	}>;
}

export interface ProvisionGrantInput {
	readonly tenantId: string;
	readonly actorId: string;
	readonly accountId: string;
	readonly capabilities: readonly string[];
	readonly expiresAt: number | null;
	readonly note: string | null;
}

export interface ProvisionGrant {
	readonly id: string;
	readonly capabilities: readonly string[];
	readonly grantedAt: number;
}

export const INBOX_FILENAME = 'sandbox-credential.json';
/* The launcher deletes the inbox once it has sealed the token, so the inbox
   cannot also be the record that provisioning happened. Without a marker the
   platform's second configuration generation would mint a second token after the
   launcher had already consumed the first, leaving a live credential on disk
   that nobody reads and that a later run would seal instead of replacing. */
const MARKER_FILENAME = 'provisioned.marker';
const WORKSPACE_NAME = 'Sandbox';
const WORKSPACE_SLUG = 'sandbox';
/* RFC 2606 reserves example.com for documentation, so this address cannot
   reach a real mail system even if a deployment relays mail. The domain has to
   carry a dot: auth rejects an address without one. */
const OWNER_EMAIL = 'sandbox-operator@example.com';
const OWNER_DISPLAY_NAME = 'Sandbox operator';
const TOKEN_LABEL = 'Sandbox launcher';
const OPERATOR = 'platform:boot';
const CREDENTIAL_MODE = 0o600;

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function sandboxDirectory(workspaceRoot: string): string {
	return join(flowdularStateDirectory(workspaceRoot), 'sandbox');
}

export function inboxPath(workspaceRoot: string): string {
	return join(sandboxDirectory(workspaceRoot), INBOX_FILENAME);
}

function markerPath(workspaceRoot: string): string {
	return join(sandboxDirectory(workspaceRoot), MARKER_FILENAME);
}

async function publishInbox(target: string, contents: string): Promise<void> {
	/* A completed inbox must appear at its final path all at once. If writing
	   fails or the process exits before rename, the marker remains absent and a
	   later boot can issue a fresh credential. */
	const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
	try {
		await writeFile(temporary, contents, {
			encoding: 'utf8',
			mode: CREDENTIAL_MODE,
			flag: 'wx',
		});
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

/* Why this lives here rather than in a command.

   The embedded database is single-process, so a second process cannot open it
   while the platform is serving. A launcher that shells out to a CLI to
   provision therefore cannot work, and would deadlock rather than fail. The
   platform already holds the database, its leases and the auth runtime, and
   already runs every module's migrations before the first request, so this is
   the one place the credential can be created without a second writer and
   without a new HTTP surface for a machine to call.

   What it does not do: create an account in a deployment that did not ask for
   one. It runs only for a local adapter, only when the sandbox launcher has
   asked for it, and it reuses an existing account and workspace rather than
   replacing them. */
export async function provisionSandboxCredential(
	options: ProvisionInboxOptions,
): Promise<string | null> {
	const log = options.log ?? (() => undefined);
	/* One credential per workspace, for the life of the deployment. The marker is
	   written after the token and never removed by the launcher, so a reload
	   resolves the configuration again without minting a second one. */
	if (await exists(markerPath(options.workspaceRoot))) return null;
	if (await exists(inboxPath(options.workspaceRoot))) {
		await writeFile(markerPath(options.workspaceRoot), 'collected\n', {
			encoding: 'utf8',
			mode: CREDENTIAL_MODE,
		});
		return inboxPath(options.workspaceRoot);
	}
	const auth = await options.auth.service();
	const account = await auth.findAccountAccess(OWNER_EMAIL);
	let tenantId: string | null = null;
	let accountId: string | null = null;

	if (account) {
		const tenant = account.tenants.find(
			(candidate) => candidate.slug === WORKSPACE_SLUG,
		);
		if (tenant) {
			tenantId = tenant.tenantId;
			accountId = account.accountId;
		}
	}
	if (tenantId === null || accountId === null) {
		/* A password the operator never sees and never has to store. The account
		   exists to hold the sandbox grant, and the grant is what the token
		   carries, so a human sign-in through it is not a supported path. */
		await auth.provisionWorkspace({
			name: WORKSPACE_NAME,
			slug: WORKSPACE_SLUG,
			ownerEmail: OWNER_EMAIL,
			ownerDisplayName: OWNER_DISPLAY_NAME,
			operator: OPERATOR,
			password: randomBytes(32).toString('base64url'),
		});
		const created = await auth.findAccountAccess(OWNER_EMAIL);
		const tenant = created?.tenants.find(
			(candidate) => candidate.slug === WORKSPACE_SLUG,
		);
		if (!created || !tenant) {
			throw new Error(
				`The sandbox workspace was created but ${OWNER_EMAIL} does not resolve to it.`,
			);
		}
		accountId = created.accountId;
		tenantId = tenant.tenantId;
		log(`created the sandbox workspace ${WORKSPACE_SLUG}`);
	}

	const held = new Set(await auth.listMembershipScopes(accountId, tenantId));
	const capabilities = SANDBOX_GRANT_CAPABILITIES.filter((capability) =>
		held.has(capability),
	);
	if (capabilities.length === 0) {
		throw new Error(
			`${OWNER_EMAIL} holds no sandbox scope, so no sandbox credential can be issued. Run \`pnpm flowdular auth sync-scopes --apply\` and reload.`,
		);
	}

	const grants = await options.listGrants(tenantId);
	const existing = grants.find(
		(grant) =>
			typeof grant === 'object' &&
			grant !== null &&
			accountId === (grant as { accountId?: string }).accountId,
	);
	if (!existing) {
		await options.grant({
			tenantId,
			actorId: OPERATOR,
			accountId,
			capabilities,
			expiresAt: null,
			note: 'Granted by the platform for the sandbox launcher.',
		});
		log('granted sandbox access');
	}

	const issued = await auth.issueApiToken({
		tenantId,
		accountId,
		label: TOKEN_LABEL,
		scopes: capabilities,
		allowWrites: true,
		allowedOrigins: [],
		rateLimitPerMinute: 0,
		expiresAt: null,
		createdBy: OPERATOR,
	});

	const target = inboxPath(options.workspaceRoot);
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	await publishInbox(
		target,
		`${JSON.stringify(
			{
				version: 1,
				platformTenantId: tenantId,
				email: OWNER_EMAIL,
				token: issued.token,
				capabilities,
			},
			null,
			'\t',
		)}\n`,
	);
	await writeFile(markerPath(options.workspaceRoot), 'provisioned\n', {
		encoding: 'utf8',
		mode: CREDENTIAL_MODE,
	});
	log('issued a sandbox-scoped API token');
	return target;
}
