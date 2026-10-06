import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_CONFIGURATION,
	loadSandboxConfiguration,
	openSecret,
	saveSandboxConfiguration,
	sealSecret,
} from '../src/server/config.ts';
import {
	collectProvisionedCredential,
	recordPlatformAddress,
	writeCredentialForTest,
} from '../src/server/provision-local.ts';

async function workspace(): Promise<{ root: string; inbox: string }> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-collect-'));
	await writeFile(join(root, 'flowdular.json'), '{"schemaVersion":1}\n');
	const state = join(root, '.flowdular', 'sandbox');
	await mkdir(state, { recursive: true });
	const inbox = join(state, 'sandbox-credential.json');
	await writeCredentialForTest(inbox, {
		platformTenantId: 'tenant-1',
		email: 'sandbox-operator@example.com',
		token: 'fd_test_recoverable_token',
		capabilities: ['sandbox.access.use'],
	});
	return { root, inbox };
}

describe('collecting a provisioned sandbox credential', () => {
	it('retains the inbox when local secret storage fails, then recovers', async () => {
		const { root, inbox } = await workspace();
		const key = join(root, '.flowdular', 'sandbox', 'secret.key');
		try {
			await mkdir(key);
			await expect(
				collectProvisionedCredential({
					workspaceRoot: root,
					platformUrl: 'http://127.0.0.1:4310',
				}),
			).rejects.toThrow();
			expect(await readFile(inbox, 'utf8')).toContain(
				'fd_test_recoverable_token',
			);
			await rm(key, { recursive: true });
			expect(
				await collectProvisionedCredential({
					workspaceRoot: root,
					platformUrl: 'http://127.0.0.1:4310',
				}),
			).toBe(true);
			const stored = await loadSandboxConfiguration(root);
			expect(stored.platformToken).not.toBeNull();
			expect(await openSecret(root, stored.platformToken!)).toBe(
				'fd_test_recoverable_token',
			);
			await expect(readFile(inbox, 'utf8')).rejects.toMatchObject({
				code: 'ENOENT',
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('removes a leftover plaintext inbox after a token was already sealed', async () => {
		const { root, inbox } = await workspace();
		try {
			await saveSandboxConfiguration(root, {
				...DEFAULT_CONFIGURATION,
				platformToken: await sealSecret(root, 'fd_already_sealed_token'),
			});
			expect(
				await collectProvisionedCredential({
					workspaceRoot: root,
					platformUrl: 'http://127.0.0.1:4310',
				}),
			).toBe(false);
			await expect(readFile(inbox, 'utf8')).rejects.toMatchObject({
				code: 'ENOENT',
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe('recording the platform address', () => {
	async function connected(platformUrl: string): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-address-'));
		await writeFile(join(root, 'flowdular.json'), '{"schemaVersion":1}\n');
		await saveSandboxConfiguration(root, {
			...DEFAULT_CONFIGURATION,
			platformUrl,
			platformToken: await sealSecret(root, 'fd_stored_platform_token'),
		});
		return root;
	}

	it('records the started address for a workspace without a credential', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-address-'));
		try {
			await recordPlatformAddress({
				workspaceRoot: root,
				platformUrl: 'http://127.0.0.1:4311',
				startedByLauncher: true,
			});
			expect((await loadSandboxConfiguration(root)).platformUrl).toBe(
				'http://127.0.0.1:4311',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('moves a local credential to the port the launcher started the platform on', async () => {
		const root = await connected('http://127.0.0.1:4311');
		try {
			await recordPlatformAddress({
				workspaceRoot: root,
				platformUrl: 'http://127.0.0.1:4312',
				startedByLauncher: true,
			});
			const stored = await loadSandboxConfiguration(root);
			expect(stored.platformUrl).toBe('http://127.0.0.1:4312');
			expect(await openSecret(root, stored.platformToken!)).toBe(
				'fd_stored_platform_token',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('keeps the configured connection of a platform the launcher did not start', async () => {
		const local = await connected('http://127.0.0.1:4311');
		const remote = await connected('https://erp.example.com');
		try {
			await recordPlatformAddress({
				workspaceRoot: local,
				platformUrl: 'http://127.0.0.1:4310',
				startedByLauncher: false,
			});
			await recordPlatformAddress({
				workspaceRoot: remote,
				platformUrl: 'http://127.0.0.1:4312',
				startedByLauncher: true,
			});
			expect((await loadSandboxConfiguration(local)).platformUrl).toBe(
				'http://127.0.0.1:4311',
			);
			expect((await loadSandboxConfiguration(remote)).platformUrl).toBe(
				'https://erp.example.com',
			);
		} finally {
			await rm(local, { recursive: true, force: true });
			await rm(remote, { recursive: true, force: true });
		}
	});
});
