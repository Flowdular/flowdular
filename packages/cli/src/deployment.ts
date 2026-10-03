import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import {
	failure,
	success,
	type CommandEnvelope,
} from '@flowdular/cli-protocol';
import type { ParsedArguments } from './arguments.ts';
import type { Workspace } from './workspace.ts';

export type DeploymentTarget =
	| 'docker'
	| 'kubernetes'
	| 'render'
	| 'vercel'
	| 'cloudflare';

export interface DeploymentAdapter {
	readonly id: DeploymentTarget;
	readonly runtime:
		| 'persistent-container'
		| 'request-container'
		| 'managed-container';
	readonly backgroundJobs:
		| 'in-process'
		| 'separate-worker-required'
		| 'lifecycle-unverified';
	readonly launch: 'local' | 'operator' | 'unavailable';
	readonly summary: string;
}

/** A target can be launched only when it keeps the module workers alive. */
export const deploymentAdapters: readonly DeploymentAdapter[] = [
	{
		id: 'docker',
		runtime: 'persistent-container',
		backgroundJobs: 'in-process',
		launch: 'local',
		summary:
			'Docker Compose starts Flowdular, PostgreSQL and object storage on this host.',
	},
	{
		id: 'kubernetes',
		runtime: 'persistent-container',
		backgroundJobs: 'in-process',
		launch: 'operator',
		summary:
			'Kubernetes manifests require a cluster, managed secrets, PostgreSQL and object storage.',
	},
	{
		id: 'render',
		runtime: 'persistent-container',
		backgroundJobs: 'in-process',
		launch: 'operator',
		summary:
			'Render Blueprint builds the Flowdular container as an always-on web service.',
	},
	{
		id: 'vercel',
		runtime: 'request-container',
		backgroundJobs: 'separate-worker-required',
		launch: 'unavailable',
		summary:
			'Vercel Functions stop idle instances; Flowdular workers require a persistent process.',
	},
	{
		id: 'cloudflare',
		runtime: 'managed-container',
		backgroundJobs: 'lifecycle-unverified',
		launch: 'unavailable',
		summary:
			'Cloudflare supports explicit Container lifecycle, but Flowdular has no verified restart, secret and rollout adapter yet.',
	},
] as const;

interface DeploymentCheck {
	readonly id: string;
	readonly status: 'pass' | 'action-required' | 'unsupported';
	readonly message: string;
}

interface DeploymentRecord {
	readonly auditId: string;
	readonly target: 'docker';
	readonly createdAt: string;
	readonly outcome: 'pending' | 'started' | 'unknown';
}

const DEPLOYMENT_HISTORY_LIMIT = 64;

async function recordDeployment(
	root: string,
	record: DeploymentRecord,
): Promise<void> {
	const directory = join(root, '.flowdular');
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if (!(await lstat(directory)).isDirectory()) {
		throw new Error(
			'Deployment audit directory must be a directory inside the workspace.',
		);
	}
	const path = join(directory, 'deployments.json');
	let history: DeploymentRecord[] = [];
	try {
		const entry = await lstat(path);
		if (!entry.isFile() || entry.size > 128 * 1024) {
			throw new Error(
				'Deployment audit journal is not a bounded regular file.',
			);
		}
		history = JSON.parse(await readFile(path, 'utf8')) as DeploymentRecord[];
		if (!Array.isArray(history))
			throw new Error('Deployment audit journal is invalid.');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const previous = history.findIndex(
		(entry) => entry.auditId === record.auditId,
	);
	if (previous >= 0) history.splice(previous, 1);
	history.push(record);
	history = history.slice(-DEPLOYMENT_HISTORY_LIMIT);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(history), {
			flag: 'wx',
			mode: 0o600,
		});
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function workspaceFile(root: string, path: string): Promise<boolean> {
	try {
		const file = join(root, path);
		if (!(await lstat(file)).isFile()) return false;
		const canonicalRoot = await realpath(root);
		const canonicalFile = await realpath(file);
		const pathFromRoot = relative(canonicalRoot, canonicalFile);
		return (
			pathFromRoot !== '' &&
			!pathFromRoot.startsWith('..') &&
			!isAbsolute(pathFromRoot)
		);
	} catch {
		return false;
	}
}

function dockerAvailable(): boolean {
	const result = spawnSync('docker', ['compose', 'version'], {
		stdio: 'ignore',
		timeout: 5000,
	});
	return !result.error && result.status === 0;
}

function renderDeployUrl(root: string): string | null {
	const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
		maxBuffer: 2048,
		timeout: 3000,
	});
	if (result.error || result.status !== 0) return null;
	const remote = result.stdout.trim();
	const ssh = /^git@(github\.com|gitlab\.com|bitbucket\.org):(.+)$/.exec(
		remote,
	);
	let url: URL;
	try {
		url = new URL(ssh ? `https://${ssh[1]}/${ssh[2]}` : remote);
	} catch {
		return null;
	}
	if (
		url.protocol !== 'https:' ||
		!['github.com', 'gitlab.com', 'bitbucket.org'].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		return null;
	const repository = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
	if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(repository)) return null;
	return `https://render.com/deploy?repo=${encodeURIComponent(`https://${url.hostname}/${repository}`)}`;
}

export async function deploymentPlan(
	workspace: Workspace,
	target: DeploymentTarget,
): Promise<CommandEnvelope> {
	const adapter = deploymentAdapters.find((entry) => entry.id === target)!;
	const checks: DeploymentCheck[] = [];
	if (target === 'docker') {
		for (const path of [
			'infra/docker/start.mjs',
			'infra/docker/Dockerfile',
			'infra/docker/compose.yaml',
			'infra/docker/.env.example',
		]) {
			checks.push({
				id: path,
				status: (await workspaceFile(workspace.root, path))
					? 'pass'
					: 'action-required',
				message: path,
			});
		}
		checks.push({
			id: 'docker-compose',
			status: dockerAvailable() ? 'pass' : 'action-required',
			message: 'Docker Compose must be installed and runnable on this host.',
		});
	} else if (target === 'kubernetes' || target === 'render') {
		if (target === 'render') {
			checks.push({
				id: 'render-blueprint',
				status: (await workspaceFile(workspace.root, 'render.yaml'))
					? 'pass'
					: 'action-required',
				message: 'render.yaml must be present at the repository root.',
			});
		}
		checks.push({
			id: 'external-services',
			status: 'action-required',
			message:
				target === 'render'
					? 'Provide PostgreSQL with separate runtime, background and migrator roles, verified TLS, object storage, encryption keys and backups. Render Blueprint cannot directly wire its managed Postgres internal URL because that URL does not support verify-full TLS.'
					: 'Provide PostgreSQL with separate runtime, background and migrator roles, verified TLS, object storage, encryption keys and backups.',
		});
		checks.push({
			id: 'provider-configuration',
			status: 'action-required',
			message:
				target === 'render'
					? 'Connect a repository to Render Blueprint and provide the prompted database, storage and TLS CA settings. Render supplies the public origin.'
					: 'Configure Kubernetes Secrets, public HTTPS origin, image and readiness probe before applying infra/kubernetes.',
		});
	} else {
		checks.push({
			id: 'persistent-workers',
			status: 'unsupported',
			message: adapter.summary,
		});
	}
	return success({
		target,
		adapter,
		status: checks.every((check) => check.status === 'pass')
			? 'ready-to-start'
			: checks.some((check) => check.status === 'unsupported')
				? 'unsupported'
				: 'action-required',
		checks,
		command:
			target === 'docker'
				? 'flowdular deploy start docker --apply'
				: target === 'kubernetes'
					? 'See infra/README.md for the Kubernetes deployment procedure.'
					: target === 'render'
						? 'Connect render.yaml as a Render Blueprint after supplying external PostgreSQL and object storage.'
						: null,
		deployUrl: target === 'render' ? renderDeployUrl(workspace.root) : null,
	});
}

export async function runDeployment(
	workspace: Workspace,
	action: string | undefined,
	target: string | undefined,
	arguments_: ParsedArguments,
	terminal = {
		input: Boolean(process.stdin.isTTY),
		output: Boolean(process.stdout.isTTY),
		errors: Boolean(process.stderr.isTTY),
	},
): Promise<CommandEnvelope> {
	if (action === 'targets') return success({ adapters: deploymentAdapters });
	const adapter = deploymentAdapters.find((entry) => entry.id === target);
	if (!adapter || !['plan', 'start'].includes(action ?? '')) {
		return failure(
			'USAGE_ERROR',
			'Use deploy targets, deploy plan <docker|kubernetes|render|vercel|cloudflare>, or deploy start docker --apply.',
		);
	}
	if (action === 'plan') return deploymentPlan(workspace, adapter.id);
	if (!arguments_.flags.has('apply'))
		return deploymentPlan(workspace, adapter.id);
	if (adapter.launch !== 'local') {
		return failure(
			'DEPLOY_TARGET_UNAVAILABLE',
			`${adapter.id} cannot launch a complete Flowdular deployment: ${adapter.summary}`,
		);
	}
	if (arguments_.flags.has('json')) {
		return failure(
			'INTERACTIVE_OUTPUT_REQUIRED',
			'The local launcher prints the one-time setup token. Run without --json in a private terminal.',
		);
	}
	if (!terminal.input || !terminal.output || !terminal.errors) {
		return failure(
			'INTERACTIVE_TERMINAL_REQUIRED',
			'The local launcher prints the one-time setup token and requires a private interactive terminal.',
		);
	}
	const plan = await deploymentPlan(workspace, adapter.id);
	if (
		!plan.ok ||
		(plan.data as { status: string }).status !== 'ready-to-start'
	) {
		return failure(
			'DEPLOY_PREFLIGHT_FAILED',
			'The Docker deployment preflight did not pass.',
			{
				plan: plan.data,
			},
		);
	}
	const directory = join(workspace.root, '.flowdular');
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if (!(await lstat(directory)).isDirectory()) {
		return failure(
			'DEPLOY_AUDIT_FAILED',
			'The local audit directory is invalid.',
		);
	}
	const lockPath = join(directory, 'deployment.lock');
	let lock;
	try {
		lock = await open(lockPath, 'wx', 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			return failure(
				'DEPLOY_IN_PROGRESS',
				'Another deployment is running in this workspace.',
			);
		}
		throw error;
	}
	const auditId = randomUUID();
	const record: DeploymentRecord = {
		auditId,
		target: 'docker',
		createdAt: new Date().toISOString(),
		outcome: 'pending',
	};
	try {
		await recordDeployment(workspace.root, record);
		return await launchDocker(workspace, arguments_, record);
	} finally {
		await lock.close();
		await rm(lockPath, { force: true });
	}
}

async function launchDocker(
	workspace: Workspace,
	arguments_: ParsedArguments,
	record: DeploymentRecord,
): Promise<CommandEnvelope> {
	const flags = ['--no-open', '--no-build'].filter((flag) =>
		arguments_.flags.has(flag.slice(2)),
	);
	const result = spawnSync(
		process.execPath,
		[join(workspace.root, 'infra/docker/start.mjs'), ...flags],
		{
			cwd: workspace.root,
			stdio: 'inherit',
		},
	);
	if (result.error || result.status !== 0) {
		await recordDeployment(workspace.root, { ...record, outcome: 'unknown' });
		return {
			...failure(
				'DEPLOY_START_FAILED',
				'The Docker launcher failed. Check its output above; the stack may have started.',
			),
			auditId: record.auditId,
		};
	}
	await recordDeployment(workspace.root, { ...record, outcome: 'started' });
	return {
		...success({
			target: 'docker',
			status: 'started',
			liveness: '/api/health',
			readiness: '/api/ready',
		}),
		auditId: record.auditId,
	};
}
