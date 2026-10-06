import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(process.argv[2]);
const database = join(root, '.flowdular', 'test-first-run');
const credentialPath = join(
	root,
	'.flowdular',
	'sandbox',
	'sandbox-credential.json',
);
const setupTokenPath = join(root, '.flowdular', 'setup-token');
const sandboxState = join(root, '.flowdular', 'sandbox');
const environment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('FD_')),
);
const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const { port } = socket.address();
await new Promise((resolveClose) => socket.close(resolveClose));

let logs = '';
function startApplication() {
	logs = '';
	const child = spawn(
		process.execPath,
		[
			`--env-file-if-exists=${join(root, '.env')}`,
			'platform/scripts/dev.mjs',
			'--port',
			String(port),
			'--host',
			'127.0.0.1',
			'--no-open',
		],
		{
			cwd: root,
			env: {
				...environment,
				NODE_ENV: 'development',
				FD_DATABASE_ADAPTER: 'pglite',
				FD_DATABASE_PGLITE_DIRECTORY: database,
				FD_SANDBOX_PROVISION: 'true',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	for (const stream of [child.stdout, child.stderr])
		stream.on('data', (chunk) => {
			logs = (logs + chunk.toString()).slice(-12000);
		});
	return child;
}

function safeLogs() {
	return logs.replace(/(\bToken\s+)[^\s]+/g, '$1[redacted]');
}

async function stopApplication(child) {
	if (child.exitCode !== null) return;
	const exited = once(child, 'exit');
	child.kill('SIGTERM');
	const force = setTimeout(() => child.kill('SIGKILL'), 5000);
	await exited;
	clearTimeout(force);
}

const origin = `http://127.0.0.1:${port}`;
async function submitSetup(fields, cookie) {
	return fetch(`${origin}/setup`, {
		method: 'POST',
		headers: cookie ? { cookie } : {},
		body: new URLSearchParams(fields),
		redirect: 'manual',
		signal: AbortSignal.timeout(30_000),
	});
}

let child = startApplication();

try {
	const setupDeadline = Date.now() + 90_000;
	let setupPage;
	let setupToken;
	while (Date.now() < setupDeadline) {
		if (child.exitCode !== null) throw new Error(safeLogs());
		try {
			setupToken = (await readFile(setupTokenPath, 'utf8')).trim();
			const response = await fetch(`${origin}/setup`, {
				signal: AbortSignal.timeout(2000),
			});
			if (
				response.ok &&
				response.headers.get('x-flowdular-setup') === 'first-run'
			) {
				setupPage = await response.text();
				if (setupPage.includes('Unlock setup')) break;
			}
		} catch {
			/* The first-run server is still starting. */
		}
		await delay(200);
	}
	assert.ok(setupToken && setupPage?.includes('Unlock setup'), safeLogs());
	const unlocked = await submitSetup({ step: 'unlock', token: setupToken });
	assert.equal(unlocked.status, 303, safeLogs());
	const cookie = unlocked.headers.get('set-cookie')?.split(';')[0];
	assert.ok(cookie, safeLogs());
	const workspace = await fetch(`${origin}/setup`, {
		headers: { cookie },
		signal: AbortSignal.timeout(30_000),
	});
	const workspaceHtml = await workspace.text();
	assert.ok(workspaceHtml.includes('Create your workspace'), safeLogs());
	assert.ok(workspaceHtml.includes('configured by deployment'), safeLogs());
	const csrf = /name="setupCsrf" value="([^"]+)"/.exec(workspaceHtml)?.[1];
	assert.ok(csrf, safeLogs());
	const review = await submitSetup(
		{
			step: 'workspace',
			setupCsrf: csrf,
			workspaceName: 'SDK Consumer',
			workspaceSlug: 'sdk-consumer',
			ownerName: 'SDK Owner',
			ownerEmail: 'sdk-owner@example.test',
			ownerPassword: 'Owner!23456789',
			ownerPasswordConfirm: 'Owner!23456789',
			applicationPath: '/app',
		},
		cookie,
	);
	assert.ok(
		(await review.text()).includes('Migrate and create workspace'),
		safeLogs(),
	);
	const completed = await submitSetup(
		{ step: 'apply', setupCsrf: csrf },
		cookie,
	);
	assert.ok(
		(await completed.text()).includes('Flowdular is ready'),
		safeLogs(),
	);
	await stopApplication(child);
	child = startApplication();

	const applicationDeadline = Date.now() + 90_000;
	let credential;
	let healthy = false;
	while (Date.now() < applicationDeadline) {
		if (child.exitCode !== null) throw new Error(safeLogs());
		try {
			credential = JSON.parse(await readFile(credentialPath, 'utf8'));
			const health = await fetch(`${origin}/api/health`, {
				signal: AbortSignal.timeout(2000),
			});
			if (health.ok) {
				healthy = true;
				break;
			}
		} catch {
			/* Provisioning and the application boot can take several seconds. */
		}
		await delay(200);
	}
	assert.ok(credential, safeLogs());
	assert.ok(healthy, safeLogs());
	assert.ok(
		typeof credential.token === 'string' && credential.token.length > 20,
	);
	assert.ok(credential.capabilities.includes('sandbox.access.use'));
	const login = await fetch(`${origin}/auth/login`, {
		signal: AbortSignal.timeout(30_000),
	});
	assert.equal(login.status, 200, safeLogs());
	const signedIn = await fetch(`${origin}/api/auth/sign-in`, {
		method: 'POST',
		headers: { origin, 'content-type': 'application/json' },
		body: JSON.stringify({
			email: 'sdk-owner@example.test',
			password: 'Owner!23456789',
		}),
		signal: AbortSignal.timeout(30_000),
	});
	assert.equal(signedIn.status, 200, safeLogs());
	const session = await signedIn.json();
	assert.equal(session.principal.email, 'sdk-owner@example.test');
	assert.deepEqual(
		session.principal.scopes
			.filter((scope) => scope.startsWith('example.'))
			.sort(),
		['example.notes.manage', 'example.notes.read'],
	);
	console.log(
		'Fresh application completes setup and then provisions sandbox access on embedded PostgreSQL.',
	);
} finally {
	await stopApplication(child);
	await rm(sandboxState, { recursive: true, force: true });
	await rm(database, { recursive: true, force: true });
}
