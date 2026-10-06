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
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	DEFAULT_CONFIGURATION,
	loadSandboxConfiguration,
	openSecret,
	saveSandboxConfiguration,
	sealSecret,
} from '../src/server/config.ts';
import { setLocalFileTestHooks } from '../src/server/local-file.ts';
import {
	collectProvisionedCredential,
	recordPlatformAddress,
	writeCredentialForTest,
} from '../src/server/provision-local.ts';
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
