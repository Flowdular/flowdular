import { randomBytes } from 'node:crypto';
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
import { createRouter } from '@octanejs/app-core';
import {
	DEFAULT_CONFIGURATION,
	loadSandboxConfiguration,
	openSecret,
	saveSandboxConfiguration,
	sealSecret,
	updateSandboxConfiguration,
	type SealedSecret,
} from '../src/server/config.ts';
import {
	replaceLocalFile,
	setLocalFileTestHooks,
} from '../src/server/local-file.ts';
import type { PreviewRuntime } from '../src/server/preview-runtime.ts';
import {
	collectProvisionedCredential,
	recordPlatformAddress,
	writeCredentialForTest,
} from '../src/server/provision-local.ts';
import {
	createSandboxRoutes,
	SANDBOX_REQUEST_HEADER,
} from '../src/server/routes.ts';
import {
	createSandboxRuntime,
	type SandboxRuntime,
} from '../src/server/runtime.ts';
import {
	readDeliveryRecord,
	writeDeliveryRecord,
	type DeliveryRecord,
} from '../src/server/delivery/record.ts';
import { completeSessionMove } from '../src/server/session-owner.ts';
import {
	appendChatEntry,
	createSession,
	readChat,
	readSession,
	removeCrashLeftovers,
	sessionPaths,
	updateSession,
	type SandboxSession,
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

/* A platform that records the Authorization header of every request. A
   booting one answers 503, so a runtime holding a credential settles its
   connection without reaching any real service; a granting one answers the
   sandbox authority check for any token, as a platform a caller runs would. */
async function recordingPlatform(granting = false): Promise<{
	readonly url: string;
	readonly authorizations: string[];
}> {
	const authorizations: string[] = [];
	const server = createServer((request, response) => {
		authorizations.push(request.headers.authorization ?? '');
		if (!granting) {
			response.statusCode = 503;
			response.end();
			return;
		}
		response.setHeader('content-type', 'application/json');
		response.end(
			JSON.stringify({
				principal: {
					tenantId: 'tenant-x',
					accountId: 'account-x',
					email: 'caller@example.test',
					displayName: 'Caller',
					role: 'owner',
					scopes: [],
					tenantName: 'Tenant',
					tenantSlug: 'tenant',
				},
				writeAllowed: true,
				authority: {
					granted: true,
					grantId: 'grant-x',
					capabilities: ['sandbox.access.use'],
					expiresAt: null,
				},
			}),
		);
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
	});
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		authorizations,
	};
}

const bootingPlatform = () => recordingPlatform(false);

const preview: PreviewRuntime = {
	compose: () => Promise.reject(new Error('no preview in tests')),
	cached: () => null,
	forget: () => undefined,
	dispose: () => undefined,
};

async function post(
	runtime: SandboxRuntime,
	path: string,
	input: Record<string, unknown>,
	cookie?: string,
): Promise<Response> {
	const router = createRouter([
		...createSandboxRoutes(runtime, preview, { port: 4320 }),
	]);
	const url = new URL(path, 'http://127.0.0.1:4320');
	const match = router.match('POST', url.pathname);
	if (!match || match.route.type !== 'server') throw new Error('no route');
	return match.route.handler({
		request: new Request(url, {
			method: 'POST',
			headers: {
				host: '127.0.0.1:4320',
				'content-type': 'application/json',
				[SANDBOX_REQUEST_HEADER]: '1',
				...(cookie ? { cookie } : {}),
			},
			body: JSON.stringify(input),
		}),
		params: match.params,
		url,
		state: new Map(),
	});
}

/* The browser sign-in a self-hosted sandbox offers before any session. */
async function connectBrowser(
	runtime: SandboxRuntime,
	input: { readonly platformUrl: string; readonly token: string },
): Promise<string> {
	const response = await post(runtime, '/sandbox/api/connect', input);
	return (response.headers.get('set-cookie') ?? '').split(';')[0]!;
}

const OPERATOR_TOKEN: SealedSecret = {
	iv: 'b3BlcmF0b3ItaXY=',
	tag: 'b3BlcmF0b3ItdGFn',
	ciphertext: 'b3BlcmF0b3ItdG9rZW4=',
};

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
		const { url: platformUrl } = await bootingPlatform();
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
		const { url: platformUrl } = await bootingPlatform();
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
		/* The launcher's first seal creates the local key; the operator's
		   connection lands while that write is in flight. */
		setLocalFileTestHooks({
			beforeRename: async (target) => {
				if (basename(target) !== 'secret.key') return;
				await saveSandboxConfiguration(root, {
					...DEFAULT_CONFIGURATION,
					platformUrl: 'http://127.0.0.1:4311',
					platformToken: OPERATOR_TOKEN,
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
		expect(stored.platformToken).toEqual(OPERATOR_TOKEN);
		expect(stored.launcherTokenFingerprint).toBeNull();
		await expect(readFile(inbox, 'utf8')).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('keeps the address of a token the operator connected before the launcher moved it', async () => {
		const root = await workspace();
		await prepareLauncherInbox(root);
		const gate = holdFirstWrite('config.json');

		const connecting = saveSandboxConfiguration(root, {
			...DEFAULT_CONFIGURATION,
			platformUrl: 'http://127.0.0.1:5000',
			platformToken: OPERATOR_TOKEN,
		});
		await gate.held;
		const collecting = collectProvisionedCredential({
			workspaceRoot: root,
			platformUrl: 'http://127.0.0.1:4311',
		});
		await gate.second;
		gate.release();
		await connecting;

		expect(await collecting).toBe(false);
		const stored = await loadSandboxConfiguration(root);
		expect(stored.platformUrl).toBe('http://127.0.0.1:5000');
		expect(stored.platformToken).toEqual(OPERATOR_TOKEN);
	});

	it('never sends the launcher credential to an address a browser sign-in names', async () => {
		const root = await workspace();
		const platform = await bootingPlatform();
		const elsewhere = await bootingPlatform();
		/* The runtime loads before the launcher collects, and nothing has
		   refreshed it since. */
		const runtime = await createSandboxRuntime(root);
		await prepareLauncherInbox(root);
		await collectProvisionedCredential({
			workspaceRoot: root,
			platformUrl: platform.url,
		});

		await connectBrowser(runtime, {
			platformUrl: elsewhere.url,
			token: 'fd_test_browser_token',
		});

		expect(elsewhere.authorizations).toEqual([]);
		/* The sign-in goes where it would have after a refresh. */
		expect(platform.authorizations).toContain('Bearer fd_test_browser_token');
		const stored = await loadSandboxConfiguration(root);
		expect(stored.platformUrl).toBe(platform.url);
		expect(await openSecret(root, stored.platformToken!)).toBe(LAUNCHER_TOKEN);
	});

	it('keeps a stored token at its address when a signed-in browser saves another', async () => {
		const mode = process.env.FD_SANDBOX_MODE;
		process.env.FD_SANDBOX_MODE = 'self-hosted';
		cleanup.push(async () => {
			if (mode === undefined) delete process.env.FD_SANDBOX_MODE;
			else process.env.FD_SANDBOX_MODE = mode;
		});
		const root = await workspace();
		const platform = await bootingPlatform();
		const elsewhere = await recordingPlatform(true);
		const runtime = await createSandboxRuntime(root);
		/* A fresh self-hosted sandbox may be pointed at an application once,
		   before it holds a token; the launcher then collects its own. */
		const cookie = await connectBrowser(runtime, {
			platformUrl: elsewhere.url,
			token: 'fd_test_browser_token',
		});
		expect(cookie).toMatch(/^flowdular_sandbox=/);
		await prepareLauncherInbox(root);
		await collectProvisionedCredential({
			workspaceRoot: root,
			platformUrl: platform.url,
		});

		const saved = await post(
			runtime,
			'/sandbox/api/config',
			{ platformUrl: elsewhere.url },
			cookie,
		);

		expect(elsewhere.authorizations).not.toContain(`Bearer ${LAUNCHER_TOKEN}`);
		expect(saved.status).toBe(400);
		expect(
			((await saved.json()) as { error: { code: string } }).error.code,
		).toBe('PLATFORM_TOKEN_REQUIRED');
		const stored = await loadSandboxConfiguration(root);
		expect(stored.platformUrl).toBe(platform.url);
		expect(await openSecret(root, stored.platformToken!)).toBe(LAUNCHER_TOKEN);
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

	it('uses the local key another process published while this one made its own', async () => {
		const root = await workspace();
		const theirs = randomBytes(32).toString('base64');
		const keyFile = join(stateDirectory(root), 'secret.key');
		setLocalFileTestHooks({
			beforeRename: async (target) => {
				if (basename(target) !== 'secret.key') return;
				/* The other process's queue is not this one's, so nothing here
				   waits for it. */
				await writeFile(keyFile, theirs, { mode: 0o600, flag: 'wx' });
			},
		});

		const sealed = await sealSecret(root, 'mine');

		setLocalFileTestHooks(null);
		expect(await readFile(keyFile, 'utf8')).toBe(theirs);
		expect(await openSecret(root, sealed)).toBe('mine');
		expect(await readdir(stateDirectory(root))).toEqual(['secret.key']);
	});

	it('creates the local key on a filesystem that makes no hard links', async () => {
		const root = await workspace();
		let refused = false;
		setLocalFileTestHooks({
			beforeRename: async (target) => {
				if (basename(target) !== 'secret.key' || refused) return;
				refused = true;
				/* What link reports on a FAT or exFAT volume under macOS. */
				throw Object.assign(new Error('operation not supported'), {
					code: 'ENOTSUP',
				});
			},
		});

		const sealed = await sealSecret(root, 'mine');

		setLocalFileTestHooks(null);
		expect(refused).toBe(true);
		expect(await openSecret(root, sealed)).toBe('mine');
		expect(await readdir(stateDirectory(root))).toEqual(['secret.key']);
	});

	it('serves the stored configuration after refusing an update', async () => {
		const root = await workspace();
		const platform = await bootingPlatform();
		/* Loaded before the launcher collects its credential. */
		const runtime = await createSandboxRuntime(root);
		await prepareLauncherInbox(root);
		await collectProvisionedCredential({
			workspaceRoot: root,
			platformUrl: platform.url,
		});

		await expect(
			runtime.update({ platformUrl: 'http://127.0.0.1:5999' }),
		).rejects.toMatchObject({ code: 'PLATFORM_TOKEN_REQUIRED' });

		expect(runtime.configuration().platformUrl).toBe(platform.url);
		expect(await openSecret(root, runtime.configuration().platformToken!)).toBe(
			LAUNCHER_TOKEN,
		);
	});
});

function newSession(root: string, title = 'Rotation'): Promise<SandboxSession> {
	return createSession({
		workspaceRoot: root,
		owner: {
			platformUrl: 'https://business.example',
			accountId: 'alice',
			tenantId: 'tenant-a',
		},
		kind: 'new-module',
		moduleId: 'booking.core',
		title,
		brief: 'Rotate a long transcript',
		blueprint: 'new-module@1.0.0',
		role: 'business-manager',
		driver: 'fake',
		install: false,
	});
}

/* Past the 32 MiB rotation threshold and past the 2,000 lines a rotation
   keeps, so a finished rotation would be visible. */
async function writeLongTranscript(chatLog: string): Promise<void> {
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
	await writeFile(chatLog, `${lines.join('\n')}\n`, { mode: 0o600 });
}

describe('transcript rotation', () => {
	it('keeps the whole transcript when its rotation stops before the rename', async () => {
		const root = await workspace();
		const session = await newSession(root);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await writeLongTranscript(paths.chatLog);
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

	it('keeps an entry appended while a rotation is between its read and its rename', async () => {
		const root = await workspace();
		const session = await newSession(root);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await writeLongTranscript(paths.chatLog);
		const held = deferred();
		const queued = deferred();
		const release = deferred();
		let rotations = 0;
		setLocalFileTestHooks({
			beforeRename: async (target) => {
				if (target !== paths.chatLog || ++rotations > 1) return;
				held.resolve();
				await release.promise;
			},
			queued: (target) => {
				if (target === paths.chatLog) queued.resolve();
			},
		});

		const rotating = appendChatEntry(root, session, {
			kind: 'user',
			role: 'operator',
			text: 'rotating',
		});
		await held.promise;
		const appending = appendChatEntry(root, session, {
			kind: 'user',
			role: 'operator',
			text: 'during the rotation',
		});
		/* The append either waits for the rotation or lands beside it. */
		await Promise.race([queued.promise, appending]);
		release.resolve();
		await Promise.all([rotating, appending]);

		const entries = await readChat(root, session);
		expect(entries.map((entry) => entry.text).slice(-2)).toEqual([
			'rotating',
			'during the rotation',
		]);
		expect(entries.length).toBeLessThan(2_200);
	});
});

describe('session and delivery records', () => {
	it('keeps the previous session record when its replacement stops before the rename', async () => {
		const root = await workspace();
		const session = await newSession(root, 'before');
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		setLocalFileTestHooks({
			beforeRename: async (target) => {
				if (target === paths.record) throw new Error('process died');
			},
		});

		await expect(
			updateSession(root, session.id, { title: 'after' }),
		).rejects.toThrow('process died');

		setLocalFileTestHooks(null);
		expect((await readSession(root, session.id)).title).toBe('before');
		expect(
			(await readdir(paths.root)).filter((name) =>
				name.startsWith('session.json.'),
			),
		).toEqual([]);
	});

	it('writes the delivery record owner-only and keeps it when its replacement stops before the rename', async () => {
		const sessionRoot = await temporaryDirectory('flowdular-delivery-');
		const delivered: DeliveryRecord = {
			target: 'workspace',
			deliveredAt: 1,
			modules: ['booking.core'],
			branch: null,
			pullRequestUrl: null,
			compareUrl: null,
		};
		await writeDeliveryRecord(sessionRoot, delivered);
		expect((await stat(join(sessionRoot, 'delivery.json'))).mode & 0o777).toBe(
			0o600,
		);
		setLocalFileTestHooks({
			beforeRename: async (target) => {
				if (basename(target) === 'delivery.json')
					throw new Error('process died');
			},
		});

		await expect(
			writeDeliveryRecord(sessionRoot, { ...delivered, deliveredAt: 2 }),
		).rejects.toThrow('process died');

		expect(await readDeliveryRecord(sessionRoot)).toEqual(delivered);
		expect(await readdir(sessionRoot)).toEqual(['delivery.json']);
	});
});

describe('crash leftovers', () => {
	it('removes the temporary files of writers that are gone and nothing else', async () => {
		const root = await workspace();
		const session = await newSession(root);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await mkdir(paths.data, { recursive: true });
		const state = stateDirectory(root);
		/* No process ever has this PID. */
		const gone = 2_147_483_647;
		const stale = [
			join(state, `config.json.${gone}.0a1b2c3d`),
			join(state, `secret.key.${gone}.0a1b2c3d`),
			join(paths.root, `session.json.${gone}.0a1b2c3d`),
			join(paths.root, `chat.jsonl.${gone}.0a1b2c3d`),
			join(paths.root, `delivery.json.${gone}.0a1b2c3d`),
			join(paths.data, `preview-credentials.json.${gone}.0a1b2c3d`),
		];
		const kept = [
			/* This process, or another live one, may still be writing it. */
			join(state, `config.json.${process.pid}.0a1b2c3d`),
			join(state, `config.json.${process.ppid}.0a1b2c3d`),
			/* Not a name the sandbox writes. */
			join(state, `notes.${gone}.txt`),
			join(paths.root, `chat.jsonl.${gone}.tmp`),
		];
		for (const path of [...stale, ...kept])
			await writeFile(path, 'leftover', { mode: 0o600 });
		const directory = join(state, `cache.${gone}.0a1b2c3d`);
		await mkdir(directory);

		await removeCrashLeftovers(root);

		for (const path of stale)
			await expect(stat(path), path).rejects.toMatchObject({ code: 'ENOENT' });
		for (const path of [...kept, directory])
			await expect(stat(path), path).resolves.toBeDefined();
		expect((await readSession(root, session.id)).id).toBe(session.id);
	});
});

describe('local file replacement', () => {
	it('reports a replacement that landed when its directory cannot be flushed', async () => {
		const directory = await temporaryDirectory('flowdular-local-state-dir-');
		const target = join(directory, 'state.json');
		await writeFile(target, 'before', { mode: 0o600 });
		/* Writable and searchable but not readable: the rename works, opening
		   the directory to flush it does not. */
		await chmod(directory, 0o300);
		cleanup.push(() => chmod(directory, 0o700));

		await replaceLocalFile(target, 'after');

		await chmod(directory, 0o700);
		expect(await readFile(target, 'utf8')).toBe('after');
		expect(await readdir(directory)).toEqual(['state.json']);
	});
});

describe('local file replacement on Windows', () => {
	function onWindows(): void {
		const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
		Object.defineProperty(process, 'platform', {
			...platform,
			value: 'win32',
		});
		cleanup.push(async () => {
			Object.defineProperty(process, 'platform', platform);
		});
	}

	/* The rename fails with code the first count times, as it does while a
	   scanner holds the file. */
	function blockRenames(count: number, code = 'EBUSY'): void {
		let blocked = 0;
		setLocalFileTestHooks({
			beforeRename: async () => {
				if (blocked >= count) return;
				blocked += 1;
				throw Object.assign(new Error('held by another process'), { code });
			},
		});
	}

	async function target(): Promise<string> {
		const directory = await temporaryDirectory('flowdular-local-state-win-');
		const path = join(directory, 'state.json');
		await writeFile(path, 'before', { mode: 0o600 });
		return path;
	}

	it.each(['EPERM', 'EBUSY', 'EACCES'])(
		'retries a rename that %s blocks for a moment',
		async (code) => {
			onWindows();
			const path = await target();
			blockRenames(2, code);

			await replaceLocalFile(path, 'after');

			expect(await readFile(path, 'utf8')).toBe('after');
			expect(await readdir(join(path, '..'))).toEqual(['state.json']);
		},
	);

	it('gives up on a rename that stays blocked', async () => {
		onWindows();
		const path = await target();
		blockRenames(Number.POSITIVE_INFINITY);

		await expect(replaceLocalFile(path, 'after')).rejects.toMatchObject({
			code: 'EBUSY',
		});

		expect(await readFile(path, 'utf8')).toBe('before');
		expect(await readdir(join(path, '..'))).toEqual(['state.json']);
	});

	it('does not retry a refused rename on other platforms', async (context) => {
		context.skip(process.platform === 'win32', 'this is the Windows case');
		const path = await target();
		blockRenames(1);

		await expect(replaceLocalFile(path, 'after')).rejects.toMatchObject({
			code: 'EBUSY',
		});
		expect(await readFile(path, 'utf8')).toBe('before');
	});
});
