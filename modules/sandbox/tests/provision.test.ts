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

/* The platform creates the owner in first-run setup. Its own boot can issue
	   the sandbox credential without a second writer opening embedded PostgreSQL. */
describe('sandbox credential provisioning', () => {
	function auth(overrides: Partial<Record<string, unknown>> = {}): {
		auth: ProvisionAuth;
		issued: string[];
		granted: string[];
	} {
		const issued: string[] = [];
		const granted: string[] = [];
		const service = {
			async listTenants() {
				return [{ tenantId: 'tenant-1' }];
			},
			async listTenantMembers() {
				return {
					members: [
						{
							accountId: 'account-1',
							email: 'ada@example.test',
							role: 'owner',
							status: 'active',
							membershipStatus: 'active',
						},
					],
					nextCursor: null,
				};
			},
			async listMembershipScopes() {
				return SANDBOX_GRANT_CAPABILITIES as unknown as string[];
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

	it('SANDBOX-LOCAL-CREDENTIAL-SINGLE binds the owner of the only workspace and writes one private credential file', async () => {
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
			email: string;
		};
		expect(written.token).toBe('fd_test_credential');
		expect(written.platformTenantId).toBe('tenant-1');
		expect(written.email).toBe('ada@example.test');
		expect(written.capabilities).toEqual(SANDBOX_GRANT_CAPABILITIES);
		expect(harness.granted).toEqual(['account-1']);
	});

	it('reuses an existing owner grant instead of replacing it', async () => {
		const workspace = await root();
		const harness = auth({
			listTenants: async () => [{ tenantId: 'tenant-9' }],
			listTenantMembers: async () => ({
				members: [
					{
						accountId: 'account-9',
						email: 'owner@example.test',
						role: 'owner',
						status: 'active',
						membershipStatus: 'active',
					},
				],
				nextCursor: null,
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

	it('SANDBOX-LOCAL-CREDENTIAL-AMBIGUOUS refuses an ambiguous target without minting a token or creating a workspace', async () => {
		const workspace = await root();
		const harness = auth({
			listTenants: async () => [
				{ tenantId: 'tenant-1' },
				{ tenantId: 'tenant-2' },
			],
			listTenantMembers: async () => {
				throw new Error('Must not choose an owner.');
			},
		});
		await expect(
			provisionSandboxCredential({
				workspaceRoot: workspace,
				auth: harness.auth,
				listGrants: async () => [],
				grant: async () => {
					throw new Error('Must not grant.');
				},
			}),
		).rejects.toThrow(/multiple workspaces/);
		expect(harness.issued).toEqual([]);
		await expect(readFile(inboxPath(workspace))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('refuses a platform with no workspace until first-run setup finishes', async () => {
		const workspace = await root();
		const harness = auth({ listTenants: async () => [] });
		await expect(
			provisionSandboxCredential({
				workspaceRoot: workspace,
				auth: harness.auth,
				listGrants: async () => [],
				grant: async () => {
					throw new Error('Must not grant.');
				},
			}),
		).rejects.toThrow(/first-run setup/);
		expect(harness.issued).toEqual([]);
	});

	it('refuses a workspace without an active permitted owner', async () => {
		const workspace = await root();
		const harness = auth({
			listTenantMembers: async () => ({
				members: [
					{
						accountId: 'account-1',
						email: 'ada@example.test',
						role: 'owner',
						status: 'disabled',
						membershipStatus: 'active',
					},
				],
				nextCursor: null,
			}),
		});
		await expect(
			provisionSandboxCredential({
				workspaceRoot: workspace,
				auth: harness.auth,
				listGrants: async () => [],
				grant: async () => {
					throw new Error('Must not grant.');
				},
			}),
		).rejects.toThrow(/no active owner with sandbox.access.use/);
		expect(harness.issued).toEqual([]);
	});

	it('walks bounded member pages until a permitted owner is found', async () => {
		const workspace = await root();
		const cursors: (string | null | undefined)[] = [];
		const harness = auth({
			listTenantMembers: async (
				_tenantId: string,
				page: { cursor?: string | null; limit: number },
			) => {
				cursors.push(page.cursor);
				expect(page.limit).toBe(100);
				return page.cursor === null
					? {
							members: [
								{
									accountId: 'member-1',
									email: 'member@example.test',
									role: 'member',
									status: 'active',
									membershipStatus: 'active',
								},
							],
							nextCursor: 'member-1',
						}
					: {
							members: [
								{
									accountId: 'owner-2',
									email: 'owner@example.test',
									role: 'owner',
									status: 'active',
									membershipStatus: 'active',
								},
							],
							nextCursor: null,
						};
			},
		});
		await provisionSandboxCredential({
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
		expect(cursors).toEqual([null, 'member-1']);
		expect(harness.granted).toEqual(['owner-2']);
	});

	/* The platform resolves its configuration once per generation. Minting twice
	   leaves a live credential on disk that the launcher will never read. */
	it('SANDBOX-LOCAL-CREDENTIAL-IDEMPOTENT mints once, however many times the configuration is resolved', async () => {
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
		).rejects.toThrow(/no active owner with sandbox.access.use/);
	});

	it('names the file the launcher reads', () => {
		expect(INBOX_FILENAME).toBe('sandbox-credential.json');
	});
});
