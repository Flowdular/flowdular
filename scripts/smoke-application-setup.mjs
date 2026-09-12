import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(process.argv[2]);
const environment = Object.fromEntries(
	Object.entries(process.env).filter(
		([key]) => !key.startsWith('FD_') && !key.startsWith('CORELOOM_'),
	),
);
const child = spawn(
	process.execPath,
	[
		`--env-file=${join(root, '.env')}`,
		'--input-type=module',
		'-e',
		`
import {createServer} from 'vite';
const server=await createServer({root:process.cwd(),server:{host:'127.0.0.1',port:0,strictPort:false}});
await server.listen();
console.log('FD_SMOKE_PORT='+server.httpServer.address().port);
process.once('SIGTERM',()=>void server.close());
`,
	],
	{
		cwd: join(root, 'platform'),
		env: {
			...environment,
			NODE_ENV: 'development',
			FD_DATABASE_ADAPTER: 'pglite',
			FD_DATABASE_PGLITE_DIRECTORY: join(root, '.flowdular/test-setup'),
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	},
);
let logs = '',
	port;
for (const stream of [child.stdout, child.stderr])
	stream.on('data', (chunk) => {
		const text = chunk.toString();
		logs = (logs + text).slice(-16000);
		const found = /FD_SMOKE_PORT=(\d+)/.exec(logs);
		if (found) port = Number(found[1]);
	});
try {
	const deadline = Date.now() + 45000;
	while (!port && Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(logs);
		await delay(100);
	}
	assert.ok(port, logs);
	const response = await fetch(`http://127.0.0.1:${port}/auth/login`, {
		signal: AbortSignal.timeout(30000),
	});
	assert.equal(response.status, 200, logs);
	const html = await response.text();
	assert.match(html, /id="root"/);
	assert.match(html, /data-octane-hydrate/);
	assert.doesNotMatch(html, /vite-error-overlay/);
	const origin = `http://127.0.0.1:${port}`;
	const login = await fetch(`${origin}/api/auth/sign-in`, {
		method: 'POST',
		headers: { origin, 'content-type': 'application/json' },
		body: JSON.stringify({
			email: 'admin@example.com',
			password: 'Owner!23456789',
		}),
		signal: AbortSignal.timeout(30000),
	});
	assert.equal(login.status, 200, logs);
	const session = await login.json();
	assert.equal(session.principal.email, 'admin@example.com');
	assert.equal(session.principal.role, 'owner');
	for (const scope of [
		'sandbox.access.use',
		'workflows.definitions.read',
		'automations.schedules.read',
	])
		assert.ok(
			session.principal.scopes.includes(scope),
			`Demo owner needs ${scope}`,
		);
	assert.ok(login.headers.get('set-cookie'));
	console.log(
		'Freshly initialized application serves its login page and authenticates the seeded administrator.',
	);
} finally {
	if (child.exitCode === null) {
		const exited = once(child, 'exit');
		child.kill('SIGTERM');
		const force = setTimeout(() => child.kill('SIGKILL'), 5000);
		await exited;
		clearTimeout(force);
	}
}
