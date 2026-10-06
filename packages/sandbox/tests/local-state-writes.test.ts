import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	DEFAULT_CONFIGURATION,
	loadSandboxConfiguration,
	openSecret,
	saveSandboxConfiguration,
	sealSecret,
	updateSandboxConfiguration,
	type SealedSecret,
} from '../src/server/config.ts';
import { setLocalFileTestHooks } from '../src/server/local-file.ts';
import {
	collectProvisionedCredential,
	recordPlatformAddress,
	writeCredentialForTest,
} from '../src/server/provision-local.ts';
import { createSandboxRuntime } from '../src/server/runtime.ts';
import { completeSessionMove } from '../src/server/session-owner.ts';
import {
	appendChatEntry,
	createSession,
	readChat,
	sessionPaths,
} from '../src/server/sessions.ts';

const LAUNCHER_TOKEN = 'fd_test_launcher_token';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
	setLocalFileTestHooks(null);
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function temporaryDirectory(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	cleanup.push(() => rm(path, { recursive: true, force: true }));
	return path;
}

async function workspace(): Promise<string> {
	const root = await temporaryDirectory('flowdular-local-state-');
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
	);
	await writeFile(join(root, 'tsconfig.base.json'), '{}');
	await writeFile(join(root, '.prettierrc.json'), '{}');
	return root;
}

function stateDirectory(root: string): string {
	return join(root, '.flowdular', 'sandbox');
}

async function prepareLauncherInbox(root: string): Promise<string> {
	await mkdir(stateDirectory(root), { recursive: true });
	const inbox = join(stateDirectory(root), 'sandbox-credential.json');
	await writeCredentialForTest(inbox, {
		platformTenantId: 'tenant-1',
		email: 'sandbox-operator@example.com',
		token: LAUNCHER_TOKEN,
		capabilities: ['sandbox.access.use'],
	});
	return inbox;
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

/* Holds the first write of a file just before its rename until a second
   writer either waits for that file or reaches its own rename. A writer that
   does not wait has by then read what the held write is about to replace. */
function holdFirstWrite(name: string) {
	const held = deferred();
	const second = deferred();
	const release = deferred();
	let writes = 0;
	setLocalFileTestHooks({
		beforeRename: async (target) => {
			if (basename(target) !== name) return;
			writes += 1;
			if (writes > 1) return second.resolve();
			held.resolve();
			await release.promise;
		},
		queued: (target) => {
			if (basename(target) === name) second.resolve();
		},
	});
	return {
		held: held.promise,
		second: second.promise,
		release: () => release.resolve(),
	};
}

/* Answers 503 like a platform that is still booting, so a runtime holding a
   credential settles its connection without reaching any real service. */
async function bootingPlatform(): Promise<string> {
	const server = createServer((_request, response) => {
		response.statusCode = 503;
		response.end();
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('sandbox configuration writes', () => {
	it('keeps the previous configuration readable when a save stops before its rename', async () => {
		const root = await workspace();
		await prepareLauncherInbox(root);
		await collectProvisionedCredential({
			workspaceRoot: root,
			platformUrl: 'http://127.0.0.1:4311',
		});
		const stopped = deferred();
		const crash = deferred();
		setLocalFileTestHooks({
			beforeRename: async () => {
				stopped.resolve();
				await crash.promise;
			},
		});
		const moving = recordPlatformAddress({
			workspaceRoot: root,
			platformUrl: 'http://127.0.0.1:4312',
			startedByLauncher: true,
		});
		await stopped.promise;

		const atCrash = await loadSandboxConfiguration(root);
		expect(atCrash.platformUrl).toBe('http://127.0.0.1:4311');
		expect(atCrash.pendingSessionMoveFrom).toEqual([]);
		expect(await openSecret(root, atCrash.platformToken!)).toBe(LAUNCHER_TOKEN);

		crash.reject(new Error('process died'));
		await expect(moving).rejects.toThrow('process died');
		expect((await loadSandboxConfiguration(root)).platformUrl).toBe(
			'http://127.0.0.1:4311',
		);
	});

	it('leaves the previous file and no temporary file after a failed save', async () => {
		const root = await workspace();
		await saveSandboxConfiguration(root, {
			...DEFAULT_CONFIGURATION,
			driverModel: 'before',
		});
		setLocalFileTestHooks({
			beforeRename: async () => {
				throw new Error('disk full');
			},
		});

		await expect(
			saveSandboxConfiguration(root, {
				...DEFAULT_CONFIGURATION,
				driverModel: 'after',
			}),
		).rejects.toThrow('disk full');
		await expect(
			updateSandboxConfiguration(root, (current) => ({
				...current,
				driverModel: 'after',
			})),
		).rejects.toThrow('disk full');

		expect(await readdir(stateDirectory(root))).toEqual(['config.json']);
		setLocalFileTestHooks(null);
		expect((await loadSandboxConfiguration(root)).driverModel).toBe('before');
	});

	it('refuses a symlinked configuration file and leaves the link alone', async () => {
		const root = await workspace();
		const outside = join(
			await temporaryDirectory('flowdular-local-state-outside-'),
			'config.json',
		);
		await writeFile(outside, 'outside-file');
		await mkdir(stateDirectory(root), { recursive: true });
		const target = join(stateDirectory(root), 'config.json');
		await symlink(outside, target);

		await expect(
			updateSandboxConfiguration(root, (current) => ({
				...current,
				driverModel: 'redirected',
			})),
		).rejects.toThrow(/symbolic link/);
		await expect(
			saveSandboxConfiguration(root, DEFAULT_CONFIGURATION),
		).rejects.toThrow(/symbolic link/);

		expect(await readFile(outside, 'utf8')).toBe('outside-file');
		expect((await lstat(target)).isSymbolicLink()).toBe(true);
		expect(await readdir(stateDirectory(root))).toEqual(['config.json']);
	});

	it('writes the configuration and the local key owner-only', async () => {
		const root = await workspace();
		await mkdir(stateDirectory(root), { recursive: true });
		const config = join(stateDirectory(root), 'config.json');
		await writeFile(config, '{}');
		await chmod(config, 0o644);

		await saveSandboxConfiguration(root, DEFAULT_CONFIGURATION);
		await sealSecret(root, 'owner-only');

		for (const name of ['config.json', 'secret.key']) {
			const info = await stat(join(stateDirectory(root), name));
			expect(info.mode & 0o777, name).toBe(0o600);
		}
	});

	it('lands both of two overlapping read-modify-write saves', async () => {
		const root = await workspace();
		await saveSandboxConfiguration(root, DEFAULT_CONFIGURATION);
		const gate = holdFirstWrite('config.json');

		const first = updateSandboxConfiguration(root, (current) => ({
			...current,
			driverModel: 'first-model',
		}));
		await gate.held;
		const second = updateSandboxConfiguration(root, (current) => ({
			...current,
			previewData: 'bridge',
		}));
		await gate.second;
		gate.release();
		await Promise.all([first, second]);

		const stored = await loadSandboxConfiguration(root);
		expect(stored.driverModel).toBe('first-model');
		expect(stored.previewData).toBe('bridge');
	});

	it('keeps the credential the launcher saved while the runtime was serving', async () => {
		const root = await workspace();
		const platformUrl = await bootingPlatform();
		const runtime = await createSandboxRuntime(root);
		await prepareLauncherInbox(root);
		expect(
			await collectProvisionedCredential({ workspaceRoot: root, platformUrl }),
		).toBe(true);

		await runtime.update({ previewData: 'bridge' });

		const stored = await loadSandboxConfiguration(root);
		expect(stored.previewData).toBe('bridge');
		expect(stored.platformUrl).toBe(platformUrl);
		expect(await openSecret(root, stored.platformToken!)).toBe(LAUNCHER_TOKEN);
	});

	it('keeps an operator save that overlaps the session move', async () => {
		const root = await workspace();
		const platformUrl = await bootingPlatform();
		await prepareLauncherInbox(root);
		await collectProvisionedCredential({
			workspaceRoot: root,
			platformUrl: 'http://127.0.0.1:4311',
		});
		await recordPlatformAddress({
			workspaceRoot: root,
			platformUrl,
			startedByLauncher: true,
		});
		const runtime = await createSandboxRuntime(root);
		const gate = holdFirstWrite('config.json');

		const saving = runtime.update({ previewData: 'bridge' });
		await gate.held;
		const moving = completeSessionMove({
			workspaceRoot: root,
			configuration: await loadSandboxConfiguration(root),
			principal: { tenantId: 'tenant-1', accountId: 'account-1' },
			log: () => undefined,
		});
		await gate.second;
		gate.release();
		await Promise.all([saving, moving]);

		const stored = await loadSandboxConfiguration(root);
		expect(stored.previewData).toBe('bridge');
		expect(stored.pendingSessionMoveFrom).toEqual([]);
	});

	it('keeps a token the operator connected while the launcher sealed its own', async () => {
		const root = await workspace();
		const inbox = await prepareLauncherInbox(root);
		const operatorToken: SealedSecret = {
			iv: 'b3BlcmF0b3ItaXY=',
			tag: 'b3BlcmF0b3ItdGFn',
			ciphertext: 'b3BlcmF0b3ItdG9rZW4=',
		};
		/* The launcher's first seal creates the local key; the operator's
		   connection lands while that write is in flight. */
		setLocalFileTestHooks({
			beforeRename: async (target) => {
				if (basename(target) !== 'secret.key') return;
				await saveSandboxConfiguration(root, {
					...DEFAULT_CONFIGURATION,
					platformUrl: 'http://127.0.0.1:4311',
					platformToken: operatorToken,
				});
			},
		});

		expect(
			await collectProvisionedCredential({
				workspaceRoot: root,
				platformUrl: 'http://127.0.0.1:4311',
			}),
		).toBe(false);
		const stored = await loadSandboxConfiguration(root);
		expect(stored.platformToken).toEqual(operatorToken);
		expect(stored.launcherTokenFingerprint).toBeNull();
		await expect(readFile(inbox, 'utf8')).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('agrees on one local key when two first uses overlap', async () => {
		const root = await workspace();
		const gate = holdFirstWrite('secret.key');

		const first = sealSecret(root, 'first-secret');
		await gate.held;
		const second = sealSecret(root, 'second-secret');
		await gate.second;
		gate.release();
		const [firstSealed, secondSealed] = await Promise.all([first, second]);

		expect(await openSecret(root, firstSealed)).toBe('first-secret');
		expect(await openSecret(root, secondSealed)).toBe('second-secret');
	});
});

describe('transcript rotation', () => {
	it('keeps the whole transcript when its rotation stops before the rename', async () => {
		const root = await workspace();
		const session = await createSession({
			workspaceRoot: root,
			owner: {
				platformUrl: 'https://business.example',
				accountId: 'alice',
				tenantId: 'tenant-a',
			},
			kind: 'new-module',
			moduleId: 'booking.core',
			title: 'Rotation',
			brief: 'Rotate a long transcript',
			blueprint: 'new-module@1.0.0',
			role: 'business-manager',
			driver: 'fake',
			install: false,
		});
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		/* Past the 32 MiB rotation threshold and past the 2,000 lines a
		   rotation keeps, so a finished rotation would be visible. */
		const text = 'x'.repeat(16_000);
		const lines = Array.from({ length: 2_200 }, (_, index) =>
			JSON.stringify({
				sequence: index + 1,
				at: index + 1,
				kind: 'user',
				role: 'operator',
				text,
			}),
		);
		await writeFile(paths.chatLog, `${lines.join('\n')}\n`, { mode: 0o600 });
		setLocalFileTestHooks({
			beforeRename: async (target) => {
				if (target === paths.chatLog) throw new Error('process died');
			},
		});

		await expect(
			appendChatEntry(root, session, {
				kind: 'user',
				role: 'operator',
				text: 'after the crash',
			}),
		).rejects.toThrow('process died');

		expect(await readChat(root, session)).toHaveLength(2_200);
		expect(
			(await readdir(paths.root)).filter((name) =>
				name.startsWith('chat.jsonl.'),
			),
		).toEqual([]);
	});
});
