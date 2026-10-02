import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	INBOX_FILENAME,
	inboxPath,
	provisionSandboxCredential,
	type ProvisionAuth,
} from '../src/server/provision.ts';
import { SANDBOX_GRANT_CAPABILITIES } from '../src/acl/permissions.ts';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function root(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'flowdular-provision-'));
	directories.push(path);
	await writeFile(join(path, 'flowdular.json'), '{"schemaVersion":1}\n');
	return path;
}

/* A business user must not have to sign in, mint a token and grant access before
   describing a first idea. This is the credential that removes those steps, and
   it is created inside the application boot because the embedded database cannot
   be opened by a second process. */
describe('sandbox credential provisioning', () => {
	function auth(overrides: Partial<Record<string, unknown>> = {}): {
		auth: ProvisionAuth;
		issued: string[];
		granted: string[];
	} {
		const issued: string[] = [];
		const granted: string[] = [];
		let account: unknown = null;
		const service = {
			async findAccountAccess() {
				return account as never;
			},
			async listMembershipScopes() {
				return SANDBOX_GRANT_CAPABILITIES as unknown as string[];
			},
			async provisionWorkspace(input: { ownerEmail: string }) {
				account = {
					accountId: 'account-1',
					tenants: [{ tenantId: 'tenant-1', slug: 'sandbox' }],
					email: input.ownerEmail,
				};
				return {};
			},
			async issueApiToken() {
				issued.push('token');
				return { token: 'fd_test_credential' };
			},
			...overrides,
		};
		return {
			auth: { service: async () => service as never },
			issued,
			granted,
		};
	}

	it('creates the workspace, grants access and writes one sealed-nothing file', async () => {
		const workspace = await root();
		const harness = auth();
		const path = await provisionSandboxCredential({
			workspaceRoot: workspace,
			auth: harness.auth,
			listGrants: async () => [],
			grant: async (input) => {
				harness.granted.push(input.accountId);
				return {
					id: 'grant-1',
					capabilities: input.capabilities,
					grantedAt: 1,
				};
			},
		});
		expect(path).toBe(inboxPath(workspace));
		const written = JSON.parse(await readFile(path!, 'utf8')) as {
			token: string;
			capabilities: readonly string[];
			platformTenantId: string;
		};
		expect(written.token).toBe('fd_test_credential');
		expect(written.platformTenantId).toBe('tenant-1');
		expect(written.capabilities).toEqual(SANDBOX_GRANT_CAPABILITIES);
		expect(harness.granted).toEqual(['account-1']);
	});

	it('reuses an existing account and grant instead of replacing them', async () => {
		const workspace = await root();
		const harness = auth({
			findAccountAccess: async () => ({
				accountId: 'account-9',
				tenants: [{ tenantId: 'tenant-9', slug: 'sandbox' }],
			}),
		});
		let grantsAsked = 0;
		await provisionSandboxCredential({
			workspaceRoot: workspace,
			auth: harness.auth,
			listGrants: async () => {
				grantsAsked += 1;
				return [{ accountId: 'account-9' }];
			},
			grant: async () => ({ id: 'g', capabilities: [], grantedAt: 1 }),
		});
		expect(grantsAsked).toBe(1);
		const written = JSON.parse(
			await readFile(inboxPath(workspace), 'utf8'),
		) as { platformTenantId: string };
		expect(written.platformTenantId).toBe('tenant-9');
	});

	/* The platform resolves its configuration once per generation. Minting twice
	   leaves a live credential on disk that the launcher will never read. */
	it('mints once, however many times the configuration is resolved', async () => {
		const workspace = await root();
		const harness = auth();
		const input = {
			workspaceRoot: workspace,
			auth: harness.auth,
			listGrants: async () => [],
			grant: async () => ({
				id: 'g',
				capabilities: SANDBOX_GRANT_CAPABILITIES,
				grantedAt: 1,
			}),
		};
		await provisionSandboxCredential(input);
		/* The launcher consumes and deletes the credential; a later generation
		   must still not mint another one. */
		await rm(inboxPath(workspace));
		await provisionSandboxCredential(input);
		expect(harness.issued).toEqual(['token']);
	});

	it('retries after the credential inbox cannot be written', async () => {
		const workspace = await root();
		const target = inboxPath(workspace);
		const marker = join(dirname(target), 'provisioned.marker');
		let issueCount = 0;
		const harness = auth({
			issueApiToken: async () => {
				issueCount += 1;
				if (issueCount === 1) await mkdir(target, { recursive: true });
				return { token: `fd_test_credential_${issueCount}` };
			},
		});
		const input = {
			workspaceRoot: workspace,
			auth: harness.auth,
			listGrants: async () => [],
			grant: async () => ({ id: 'g', capabilities: [], grantedAt: 1 }),
		};
		await expect(provisionSandboxCredential(input)).rejects.toThrow();
		await expect(readFile(marker, 'utf8')).rejects.toMatchObject({
			code: 'ENOENT',
		});
		expect(
			(await readdir(dirname(target))).filter((name) => name.endsWith('.tmp')),
		).toEqual([]);
		await rm(target, { recursive: true });

		expect(await provisionSandboxCredential(input)).toBe(target);
		const written = JSON.parse(await readFile(target, 'utf8')) as {
			token: string;
		};
		expect(written.token).toBe('fd_test_credential_2');
		expect(issueCount).toBe(2);
		expect(await readFile(marker, 'utf8')).toBe('provisioned\n');
	});

	it('recognizes a complete inbox left before its marker was recorded', async () => {
		const workspace = await root();
		const harness = auth();
		const input = {
			workspaceRoot: workspace,
			auth: harness.auth,
			listGrants: async () => [],
			grant: async () => ({ id: 'g', capabilities: [], grantedAt: 1 }),
		};
		await provisionSandboxCredential(input);
		const marker = join(dirname(inboxPath(workspace)), 'provisioned.marker');
		await rm(marker);

		expect(await provisionSandboxCredential(input)).toBe(inboxPath(workspace));
		expect(harness.issued).toEqual(['token']);
		expect(await readFile(marker, 'utf8')).toBe('collected\n');
	});

	it('refuses rather than issuing a token with no sandbox scope', async () => {
		const workspace = await root();
		const harness = auth({
			listMembershipScopes: async () => [] as string[],
		});
		await expect(
			provisionSandboxCredential({
				workspaceRoot: workspace,
				auth: harness.auth,
				listGrants: async () => [],
				grant: async () => ({ id: 'g', capabilities: [], grantedAt: 1 }),
			}),
		).rejects.toThrow(/no sandbox scope/);
	});

	it('names the file the launcher reads', () => {
		expect(INBOX_FILENAME).toBe('sandbox-credential.json');
	});
});
