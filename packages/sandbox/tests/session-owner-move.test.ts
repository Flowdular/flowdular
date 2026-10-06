import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouter } from '@octanejs/app-core';
import { sealSecret } from '../src/server/config.ts';
import type { PreviewRuntime } from '../src/server/preview-runtime.ts';
import {
	collectProvisionedCredential,
	recordPlatformAddress,
	writeCredentialForTest,
} from '../src/server/provision-local.ts';
import { createSandboxRoutes } from '../src/server/routes.ts';
import {
	createSandboxRuntime,
	type SandboxRuntime,
} from '../src/server/runtime.ts';
import { withSessionLock } from '../src/server/session-lock.ts';
import {
	createSession,
	readSession,
	sessionPaths,
	updateSession,
	writeSession,
	type SessionOwner,
} from '../src/server/sessions.ts';

const OLD_ADDRESS = 'http://127.0.0.1:4311';
const LAUNCHER_TOKEN = 'fd_test_launcher_token';
const OPERATOR_TOKEN = 'fd_test_operator_token';
const ACCOUNT = { tenantId: 'tenant-1', accountId: 'account-1' };

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const step of cleanup.splice(0).reverse()) await step();
});

/* Answers the sandbox authority check for both tokens as the same account, so
   only where the credential came from can tell them apart. Until it is ready
   it answers 503, as a platform the launcher started does while it boots. */
async function platform(ready = true): Promise<{
	readonly url: string;
	ready: boolean;
}> {
	const state = { url: '', ready };
	const server = createServer((request, response) => {
		const token = request.headers.authorization?.replace(/^Bearer /, '');
		if (!state.ready) {
			response.statusCode = 503;
			response.end();
			return;
		}
		if (
			request.url !== '/api/sandbox/authority' ||
			(token !== LAUNCHER_TOKEN && token !== OPERATOR_TOKEN)
		) {
			response.statusCode = 401;
			response.end();
			return;
		}
		response.setHeader('content-type', 'application/json');
		response.end(
			JSON.stringify({
				principal: {
					...ACCOUNT,
					email: 'owner@example.test',
					displayName: 'Owner',
					role: 'owner',
					scopes: [],
					tenantName: 'Tenant',
					tenantSlug: 'tenant',
				},
				authority: {
					granted: true,
					grantId: 'grant-1',
					capabilities: ['sandbox.access.use'],
					expiresAt: null,
				},
			}),
		);
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return state;
}

/* A workspace whose launcher collected its credential from a platform it
   started on the old address. */
async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-session-move-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
	);
	const state = join(root, '.flowdular', 'sandbox');
	await mkdir(state, { recursive: true });
	await writeCredentialForTest(join(state, 'sandbox-credential.json'), {
		platformTenantId: ACCOUNT.tenantId,
		email: 'owner@example.test',
		token: LAUNCHER_TOKEN,
		capabilities: ['sandbox.access.use'],
	});
	await collectProvisionedCredential({
		workspaceRoot: root,
		platformUrl: OLD_ADDRESS,
	});
	return root;
}

async function session(root: string, owner: SessionOwner): Promise<string> {
	const created = await createSession({
		workspaceRoot: root,
		kind: 'new-module',
		moduleId: 'booking.core',
		title: 'Room booking',
		brief: 'Let people book meeting rooms.',
		blueprint: 'new-module@1.0.0',
		role: 'backend-engineer',
		driver: 'claude-code',
		install: false,
		owner,
	});
	return created.id;
}

/* What a launch does before its dashboard serves: record the address of the
   platform it starts, then open the runtime the dashboard reads. */
async function relaunch(
	root: string,
	platformUrl: string,
): Promise<SandboxRuntime> {
	await recordPlatformAddress({
		workspaceRoot: root,
		platformUrl,
		startedByLauncher: true,
	});
	return createSandboxRuntime(root);
}

const preview: PreviewRuntime = {
	compose: () => Promise.reject(new Error('no preview in tests')),
	cached: () => null,
	forget: () => undefined,
	dispose: () => undefined,
};

async function opens(
	runtime: SandboxRuntime,
	sessionId: string,
): Promise<boolean> {
	const router = createRouter([
		...createSandboxRoutes(runtime, preview, { port: 4320 }),
	]);
	const url = new URL(
		`/sandbox/api/sessions/${sessionId}`,
		'http://127.0.0.1:4320',
	);
	const match = router.match('GET', url.pathname);
	if (!match || match.route.type !== 'server') throw new Error('no route');
	const response = await match.route.handler({
		request: new Request(url, { headers: { host: '127.0.0.1:4320' } }),
		params: match.params,
		url,
		state: new Map(),
	});
	return response.status === 200;
}

async function ownerAddress(root: string, sessionId: string) {
	return (await readSession(root, sessionId)).owner?.platformUrl;
}

describe('sessions follow the credential the launcher moves', () => {
	it('opens the sessions after a relaunch on a new port and logs the move', async () => {
		const next = await platform(false);
		const root = await workspace();
		const first = await session(root, { platformUrl: OLD_ADDRESS, ...ACCOUNT });
		const second = await session(root, {
			platformUrl: OLD_ADDRESS,
			...ACCOUNT,
		});
		const updatedAt = (await readSession(root, first)).updatedAt;
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

		/* The dashboard serves before the platform it started answers, and the
		   state poll connects it once the platform does. */
		const runtime = await relaunch(root, next.url);
		next.ready = true;
		await runtime.refresh();

		expect(await opens(runtime, first)).toBe(true);
		expect(await opens(runtime, second)).toBe(true);
		expect((await readSession(root, first)).updatedAt).toBe(updatedAt);
		const lines = log.mock.calls.map((values) => values.join(' '));
		expect(lines).toContainEqual(
			expect.stringContaining(
				`moved 2 sandbox sessions from ${OLD_ADDRESS} to ${next.url}`,
			),
		);
		expect(lines.join('\n')).not.toContain(LAUNCHER_TOKEN);
	});

	it('moves nothing once the operator connected a credential of their own', async () => {
		const next = await platform(false);
		const root = await workspace();
		const id = await session(root, { platformUrl: OLD_ADDRESS, ...ACCOUNT });
		const runtime = await relaunch(root, next.url);

		next.ready = true;
		await runtime.update({
			platformToken: await sealSecret(root, OPERATOR_TOKEN),
		});

		expect(runtime.connection().connected).toBe(true);
		expect(await ownerAddress(root, id)).toBe(OLD_ADDRESS);
	});

	it('never adopts the sessions of another account or tenant', async () => {
		const next = await platform();
		const root = await workspace();
		const own = await session(root, { platformUrl: OLD_ADDRESS, ...ACCOUNT });
		const otherAccount = await session(root, {
			platformUrl: OLD_ADDRESS,
			tenantId: ACCOUNT.tenantId,
			accountId: 'account-2',
		});
		const otherTenant = await session(root, {
			platformUrl: OLD_ADDRESS,
			tenantId: 'tenant-2',
			accountId: ACCOUNT.accountId,
		});

		const runtime = await relaunch(root, next.url);

		expect(await opens(runtime, own)).toBe(true);
		expect(await ownerAddress(root, otherAccount)).toBe(OLD_ADDRESS);
		expect(await ownerAddress(root, otherTenant)).toBe(OLD_ADDRESS);
	});

	it('finishes a move cut short before the platform answered on the next start', async () => {
		const next = await platform(false);
		const root = await workspace();
		const id = await session(root, { platformUrl: OLD_ADDRESS, ...ACCOUNT });
		await relaunch(root, next.url);

		next.ready = true;
		const runtime = await relaunch(root, next.url);

		expect(await opens(runtime, id)).toBe(true);
	});

	it('finishes a move cut short halfway when the next start uses another port', async () => {
		const halfway = await platform(false);
		const next = await platform();
		const root = await workspace();
		const moved = await session(root, { platformUrl: OLD_ADDRESS, ...ACCOUNT });
		const left = await session(root, { platformUrl: OLD_ADDRESS, ...ACCOUNT });
		await relaunch(root, halfway.url);
		/* What a crash leaves after the first record was rewritten: one session
		   already at the new address, the other still at the old one. */
		await updateSession(root, moved, {
			owner: { platformUrl: halfway.url, ...ACCOUNT },
		});

		const runtime = await relaunch(root, next.url);

		expect(await opens(runtime, moved)).toBe(true);
		expect(await opens(runtime, left)).toBe(true);
	});

	it('keeps a move that stopped between two sessions and finishes it on the next start', async () => {
		const next = await platform(false);
		const root = await workspace();
		const stopped = await session(root, {
			platformUrl: OLD_ADDRESS,
			...ACCOUNT,
		});
		const first = await session(root, { platformUrl: OLD_ADDRESS, ...ACCOUNT });
		/* Oldest last, so the move reaches the held session second. */
		await writeSession(root, {
			...(await readSession(root, stopped)),
			updatedAt: 1,
		});
		const record = sessionPaths(root, stopped, 'booking').record;
		const bytes = await readFile(record);
		const runtime = await relaunch(root, next.url);
		let release!: () => void;
		const held = withSessionLock(
			root,
			stopped,
			() => new Promise<void>((resolve) => (release = resolve)),
		);
		vi.spyOn(console, 'log').mockImplementation(() => undefined);

		next.ready = true;
		const connecting = runtime.refresh();
		await vi.waitFor(
			async () => expect(await ownerAddress(root, first)).toBe(next.url),
			{ timeout: 30_000 },
		);
		await rm(record);
		release();
		await held;
		await connecting;
		expect(runtime.connection().connected).toBe(true);

		await writeFile(record, bytes);
		expect(await ownerAddress(root, stopped)).toBe(OLD_ADDRESS);
		const restarted = await relaunch(root, next.url);
		expect(await opens(restarted, stopped)).toBe(true);
		expect(await opens(restarted, first)).toBe(true);
	});
});
