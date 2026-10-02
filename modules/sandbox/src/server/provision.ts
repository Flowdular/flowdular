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
		listTenants(): Promise<readonly { readonly tenantId: string }[]>;
		listTenantMembers(
			tenantId: string,
			page: { readonly cursor?: string | null; readonly limit: number },
		): Promise<{
			readonly members: readonly {
				readonly accountId: string;
				readonly email: string;
				readonly role: string;
				readonly status: 'active' | 'disabled';
				readonly membershipStatus: 'active' | 'disabled';
			}[];
			readonly nextCursor: string | null;
		}>;
		listMembershipScopes(
			accountId: string,
			tenantId: string,
		): Promise<readonly string[]>;
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
const TOKEN_LABEL = 'Sandbox launcher';
const OPERATOR = 'platform:boot';
const CREDENTIAL_MODE = 0o600;
const OWNER_PAGE_SIZE = 100;
const MAX_OWNER_PAGES = 1_000;

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

   It runs only when the sandbox launcher asks for it. A single existing
   workspace has an unambiguous target; multiple workspaces require the
   operator to connect a scoped token for the one they choose. */
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
	const tenants = await auth.listTenants();
	if (tenants.length === 0) {
		throw new Error(
			'Complete the platform first-run setup before connecting the sandbox.',
		);
	}
	if (tenants.length !== 1) {
		throw new Error(
			'This platform has multiple workspaces. Choose one in the sandbox Connect screen and provide a sandbox-scoped token for it.',
		);
	}
	const tenantId = tenants[0]!.tenantId;
	let cursor: string | null = null;
	let owner: {
		readonly accountId: string;
		readonly email: string;
		readonly capabilities: readonly string[];
	} | null = null;
	for (let pageNumber = 0; pageNumber < MAX_OWNER_PAGES; pageNumber++) {
		const page = await auth.listTenantMembers(tenantId, {
			cursor,
			limit: OWNER_PAGE_SIZE,
		});
		for (const member of page.members) {
			if (
				member.role !== 'owner' ||
				member.status !== 'active' ||
				member.membershipStatus !== 'active'
			)
				continue;
			const held = new Set(
				await auth.listMembershipScopes(member.accountId, tenantId),
			);
			const capabilities = SANDBOX_GRANT_CAPABILITIES.filter((capability) =>
				held.has(capability),
			);
			if (!capabilities.includes('sandbox.access.use')) continue;
			owner = {
				accountId: member.accountId,
				email: member.email,
				capabilities,
			};
			break;
		}
		if (owner || page.nextCursor === null) break;
		if (page.nextCursor === cursor)
			throw new Error('The owner membership page did not advance.');
		cursor = page.nextCursor;
	}
	if (!owner) {
		throw new Error(
			'This workspace has no active owner with sandbox.access.use. Grant that scope to an owner before connecting the sandbox.',
		);
	}
	const { accountId, email, capabilities } = owner;

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
				email,
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
