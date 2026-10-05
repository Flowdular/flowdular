import { spawnSync } from 'node:child_process';
import {
	cp,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../..',
);
const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const root = rootFlag < 0 ? repositoryRoot : resolve(args[rootFlag + 1] ?? '');
const packageOnly = args.includes('--package-only');

if (rootFlag >= 0 && !args[rootFlag + 1]) {
	throw new Error('--root requires a directory.');
}

if (!packageOnly) {
	const result = spawnSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

const output = join(root, '.vercel/output');
const functionRoot = join(output, 'functions/flowdular.func');
const workerFunctionRoot = join(output, 'functions/worker.func');
const WORKER_TICK_PATH = '/api/internal/worker/tick';
/* Hobby runs cron at most once a day, fails a deployment with a tighter
   schedule and caps a Function at 300 seconds; Pro and Enterprise run cron
   every minute and allow 800. A tick's window plus the agent drain must end a
   minute before maxDuration, or Vercel stops the Function mid-drain. */
const PLANS = {
	hobby: { schedule: '0 3 * * *', maxDuration: 300, agentDrainMs: 180_000 },
	pro: { schedule: '* * * * *', maxDuration: 800, agentDrainMs: 690_000 },
};
const DRAIN_MARGIN_MS = 60_000;
const planName = process.env.FD_VERCEL_PLAN?.trim() || 'pro';
if (!Object.hasOwn(PLANS, planName)) {
	throw new Error('FD_VERCEL_PLAN must be "hobby" or "pro".');
}
const plan = PLANS[planName];
const cronSchedule =
	process.env.FD_VERCEL_CRON_SCHEDULE?.trim() || plan.schedule;
if (!/^\S+( \S+){4}$/.test(cronSchedule)) {
	throw new Error(
		'FD_VERCEL_CRON_SCHEDULE must be a five-field cron expression.',
	);
}
const tickWindowMs = Number(
	process.env.FD_WORKER_TICK_WINDOW_MS?.trim() || 50_000,
);
if (
	tickWindowMs + plan.agentDrainMs + DRAIN_MARGIN_MS >
	plan.maxDuration * 1000
) {
	throw new Error(
		`FD_WORKER_TICK_WINDOW_MS leaves no time to drain agent runs within the ${plan.maxDuration} second ${planName} limit.`,
	);
}
const staticRoot = join(output, 'static');
const client = join(root, 'platform/dist/client');
const server = join(root, 'platform/dist/server');

async function assertInside(source, owner) {
	const fromOwner = relative(await realpath(owner), await realpath(source));
	if (!fromOwner || fromOwner.startsWith('..') || isAbsolute(fromOwner)) {
		throw new Error(`${source} must stay inside ${owner}.`);
	}
}

async function copyRegular(source, destination, owner = root) {
	const entry = await lstat(source);
	if (!entry.isFile() || entry.isSymbolicLink()) {
		throw new Error(`${source} must be a regular file.`);
	}
	await assertInside(source, owner);
	await mkdir(dirname(destination), { recursive: true });
	await cp(source, destination);
}

async function copyOptional(source, destination) {
	try {
		await copyRegular(source, destination);
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
}

async function copyTree(source, destination) {
	const entry = await lstat(source);
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error(`${source} must be a directory.`);
	}
	await assertInside(source, root);
	const pending = [source];
	while (pending.length > 0) {
		const directory = pending.pop();
		for (const child of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, child.name);
			if (child.isDirectory()) pending.push(path);
			else if (!child.isFile())
				throw new Error(`${path} must be a regular file.`);
		}
	}
	await cp(source, destination, { recursive: true, dereference: false });
}

await lstat(join(server, 'entry.js'));
await lstat(join(client, 'assets'));
try {
	const vercelDirectory = await lstat(join(root, '.vercel'));
	if (!vercelDirectory.isDirectory() || vercelDirectory.isSymbolicLink()) {
		throw new Error('.vercel must be a directory inside the workspace.');
	}
} catch (error) {
	if (error.code !== 'ENOENT') throw error;
}
await rm(output, { recursive: true, force: true });
await mkdir(staticRoot, { recursive: true });
await copyTree(join(client, 'assets'), join(staticRoot, 'assets'));
for (const name of ['favicon.svg', 'og.png']) {
	await copyOptional(join(client, name), join(staticRoot, name));
}

async function writeFunction(directory, runtimeRole) {
	const tick = runtimeRole === 'tick';
	await mkdir(directory, { recursive: true });
	await copyTree(server, join(directory, 'platform/dist/server'));
	await copyRegular(
		join(root, 'platform/package.json'),
		join(directory, 'platform/package.json'),
	);
	await copyRegular(
		join(root, 'flowdular.json'),
		join(directory, 'flowdular.json'),
	);
	for (const name of [
		'flowdular.modules.lock.json',
		'flowdular.module-sources.json',
	]) {
		await copyOptional(join(root, name), join(directory, name));
	}
	const modulesRoot = join(root, 'modules');
	for (const entry of await readdir(modulesRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		for (const name of ['module.json', 'spec/module.yaml']) {
			await copyOptional(
				join(modulesRoot, entry.name, name),
				join(directory, 'modules', entry.name, name),
			);
		}
	}
	await copyRegular(
		join(repositoryRoot, 'infra/vercel/handler.mjs'),
		join(directory, 'handler.mjs'),
		repositoryRoot,
	);
	await writeFile(
		join(directory, '.vc-config.json'),
		JSON.stringify({
			runtime: 'nodejs24.x',
			handler: 'handler.mjs',
			launcherType: 'Nodejs',
			maxDuration: tick ? plan.maxDuration : 300,
			supportsResponseStreaming: true,
			environment: {
				NODE_ENV: 'production',
				FD_DEPLOYMENT_TARGET: 'vercel',
				FD_RUNTIME_ROLE: runtimeRole,
				FD_TRUST_PROXY: 'true',
				FD_AUTH_SECURE_COOKIE: 'true',
				FD_DATABASE_POOL_MAX: '2',
				...(tick
					? { FD_AGENT_WORKER_DRAIN_MS: String(plan.agentDrainMs) }
					: {}),
			},
		}) + '\n',
	);
}

/* Two functions over one server build: the web function never runs a module
   worker, and the worker function runs them only inside a tick. */
await writeFunction(functionRoot, 'web');
await writeFunction(workerFunctionRoot, 'tick');
await writeFile(
	join(output, 'config.json'),
	JSON.stringify({
		version: 3,
		routes: [
			{ src: `^${WORKER_TICK_PATH}$`, dest: '/worker' },
			{ handle: 'filesystem' },
			{ src: '/(.*)', dest: '/flowdular' },
		],
		crons: [{ path: WORKER_TICK_PATH, schedule: cronSchedule }],
	}) + '\n',
);

/* The Build Output API function is self-contained. Static HTML is deliberately
   excluded so the authenticated Octane route always owns page responses. */
const manifest = JSON.parse(
	await readFile(join(output, 'config.json'), 'utf8'),
);
if (manifest.version !== 3) throw new Error('Invalid Vercel build output.');
console.log('Flowdular Vercel web artifact: .vercel/output');
