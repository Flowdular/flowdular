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
import { parse as parseYaml } from 'yaml';
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
		| 'scheduled-ticks'
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
		backgroundJobs: 'scheduled-ticks',
		launch: 'unavailable',
		summary:
			'Vercel serves HTTP from a web Function and runs module workers in a worker Function that Vercel Cron and state-changing requests tick.',
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

function dockerDaemonAvailable(): boolean {
	const result = spawnSync(
		'docker',
		['info', '--format', '{{.ServerVersion}}'],
		{
			stdio: 'ignore',
			timeout: 5000,
		},
	);
	return !result.error && result.status === 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function renderBlueprintIssue(root: string): Promise<string | null> {
	const path = 'render.yaml';
	if (!(await workspaceFile(root, path)))
		return 'render.yaml must be a regular file at the repository root.';
	let blueprint: unknown;
	try {
		if ((await lstat(join(root, path))).size > 128 * 1024)
			return 'render.yaml exceeds the 128 KiB preflight limit.';
		blueprint = parseYaml(await readFile(join(root, path), 'utf8'));
	} catch {
		return 'render.yaml must contain valid YAML.';
	}
	if (!isObject(blueprint) || !Array.isArray(blueprint.services))
		return 'render.yaml must declare a services list.';
	const service = blueprint.services.find(
		(entry: unknown) => isObject(entry) && entry.name === 'flowdular',
	);
	if (
		!isObject(service) ||
		service.type !== 'web' ||
		service.runtime !== 'docker' ||
		service.dockerfilePath !== './infra/docker/Dockerfile' ||
		service.healthCheckPath !== '/api/health' ||
		service.autoDeployTrigger !== 'off' ||
		typeof service.plan !== 'string' ||
		service.plan === 'free'
	)
		return 'render.yaml must define the persistent Flowdular Docker web service with a health check and manual deploys.';
	if (!(await workspaceFile(root, 'infra/docker/Dockerfile')))
		return 'The Render Dockerfile must be a regular file inside the repository.';
	if (!Array.isArray(service.envVars))
		return 'render.yaml must declare the Flowdular environment variables.';
	const env = new Map<string, Record<string, unknown>>();
	for (const entry of service.envVars) {
		if (!isObject(entry) || typeof entry.key !== 'string' || env.has(entry.key))
			return 'render.yaml has an invalid or duplicate environment variable.';
		env.set(entry.key, entry);
	}
	for (const [key, value] of [
		['NODE_ENV', 'production'],
		['FD_DATABASE_ADAPTER', 'postgresql'],
		['FD_DATABASE_TLS', 'verify-full'],
		['FD_AUTH_SECURE_COOKIE', 'true'],
		['FD_AUTH_ALLOW_SIGN_UP', 'false'],
		['FD_TRUST_PROXY', 'true'],
		['FD_STORAGE_ADAPTER', 's3'],
	] as const) {
		if (env.get(key)?.value !== value)
			return `render.yaml must set ${key} to ${value}.`;
	}
	for (const key of [
		'FD_DATABASE_URL',
		'FD_DATABASE_BACKGROUND_URL',
		'FD_DATABASE_MIGRATOR_URL',
		'FD_DATABASE_TLS_CA',
		'FD_STORAGE_S3_BUCKET',
		'FD_STORAGE_S3_REGION',
		'FD_STORAGE_S3_ACCESS_KEY_ID',
		'FD_STORAGE_S3_SECRET_ACCESS_KEY',
	]) {
		if (env.get(key)?.sync !== false)
			return `render.yaml must prompt for ${key}.`;
	}
	for (const key of [
		'FD_AGENT_CREDENTIAL_KEY',
		'FD_AGENT_RUN_GRANT_KEY',
		'FD_AUTH_MFA_KEY',
		'FD_APPROVAL_GRANT_KEY',
		'FD_AUTOMATIONS_CREDENTIAL_KEY',
		'FD_NOTIFICATIONS_SECRET_KEY',
		'FD_WORKFLOWS_PAYLOAD_KEY',
		'FD_WORKFLOWS_CURSOR_KEY',
		'FD_STORAGE_ENCRYPTION_KEY',
		'FD_CONNECTORS_SECRET_KEY',
		'FD_AUDIT_ANCHOR_KEY',
	]) {
		if (env.get(key)?.generateValue !== true)
			return `render.yaml must generate ${key}.`;
	}
	const publicOrigin = env.get('FD_AUTH_PUBLIC_ORIGIN');
	const fromService = publicOrigin?.fromService;
	const derivedOrigin =
		isObject(fromService) &&
		fromService.name === 'flowdular' &&
		fromService.type === 'web' &&
		fromService.envVarKey === 'RENDER_EXTERNAL_URL';
	let customOrigin = false;
	if (typeof publicOrigin?.value === 'string') {
		try {
			const url = new URL(publicOrigin.value);
			customOrigin =
				url.protocol === 'https:' &&
				!url.username &&
				!url.password &&
				!url.search &&
				!url.hash &&
				url.pathname === '/';
		} catch {
			customOrigin = false;
		}
	}
	if (
		!(derivedOrigin && publicOrigin?.value === undefined) &&
		!(customOrigin && publicOrigin?.fromService === undefined)
	)
		return 'render.yaml must set FD_AUTH_PUBLIC_ORIGIN from the Render service or to a public HTTPS origin.';
	return null;
}

function gitOutput(root: string, args: string[]): string | null {
	const result = spawnSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
		maxBuffer: 2048,
		timeout: 3000,
	});
	return result.error || result.status !== 0 ? null : result.stdout.trim();
}

function pushedGitSource(
	root: string,
	requiredPaths: readonly string[],
): string | null {
	const remote = gitOutput(root, ['remote', 'get-url', 'origin']);
	if (!remote) return null;
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
	const branch = gitOutput(root, [
		'symbolic-ref',
		'--quiet',
		'--short',
		'HEAD',
	]);
	if (!branch || !/^[A-Za-z0-9_.\/-]+$/.test(branch) || branch.includes('..'))
		return null;
	const head = gitOutput(root, ['rev-parse', '--verify', 'HEAD']);
	const remoteHead = gitOutput(root, [
		'rev-parse',
		'--verify',
		`refs/remotes/origin/${branch}`,
	]);
	if (!head || head !== remoteHead) return null;
	for (const path of requiredPaths) {
		if (
			gitOutput(root, ['ls-tree', '--name-only', 'HEAD', '--', path]) !== path
		)
			return null;
	}
	if (gitOutput(root, ['status', '--porcelain', '--', ...requiredPaths]) !== '')
		return null;
	return `https://${url.hostname}/${repository}/tree/${branch}`;
}

function renderDeployUrl(root: string): string | null {
	const source = pushedGitSource(root, [
		'render.yaml',
		'infra/docker/Dockerfile',
	]);
	return source
		? `https://render.com/deploy?repo=${encodeURIComponent(source)}`
		: null;
}

function vercelDeployUrl(root: string): string | null {
	const source = pushedGitSource(root, [
		'vercel.json',
		'infra/vercel/build.mjs',
		'infra/vercel/handler.mjs',
		'platform/octane.config.ts',
	]);
	return source
		? `https://vercel.com/new/clone?repository-url=${encodeURIComponent(source)}`
		: null;
}

async function vercelArtifactIssue(root: string): Promise<string | null> {
	for (const path of [
		'vercel.json',
		'infra/vercel/build.mjs',
		'infra/vercel/handler.mjs',
		'platform/package.json',
		'platform/octane.config.ts',
	]) {
		if (!(await workspaceFile(root, path)))
			return `${path} must be a regular file inside the workspace.`;
	}
	let config: unknown;
	try {
		const path = join(root, 'vercel.json');
		if ((await lstat(path)).size > 16 * 1024)
			return 'vercel.json exceeds the 16 KiB preflight limit.';
		config = JSON.parse(await readFile(path, 'utf8'));
	} catch {
		return 'vercel.json must contain valid JSON.';
	}
	if (
		!isObject(config) ||
		config.framework !== null ||
		config.buildCommand !== 'node infra/vercel/build.mjs'
	)
		return 'vercel.json must select the Flowdular Build Output API command.';
	return null;
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
		const composeAvailable = dockerAvailable();
		checks.push({
			id: 'docker-compose',
			status: composeAvailable ? 'pass' : 'action-required',
			message: 'Docker Compose must be installed and runnable on this host.',
		});
		checks.push({
			id: 'docker-daemon',
			status:
				composeAvailable && dockerDaemonAvailable()
					? 'pass'
					: 'action-required',
			message: 'The Docker daemon must be running and accessible on this host.',
		});
	} else if (target === 'kubernetes' || target === 'render') {
		if (target === 'render') {
			const blueprintIssue = await renderBlueprintIssue(workspace.root);
			checks.push({
				id: 'render-blueprint',
				status: blueprintIssue ? 'action-required' : 'pass',
				message:
					blueprintIssue ??
					'render.yaml contains the Flowdular Docker service.',
			});
		}
		checks.push({
			id: 'external-services',
			status: 'action-required',
			message:
				target === 'render'
					? 'Provide PostgreSQL with separate runtime, background and migrator roles, verified TLS, object storage, and backups for data and generated keys. Render Blueprint cannot directly wire its managed Postgres internal URL because that URL does not support verify-full TLS.'
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
	} else if (target === 'vercel') {
		const artifactIssue = await vercelArtifactIssue(workspace.root);
		checks.push({
			id: 'vercel-web-artifact',
			status: artifactIssue ? 'action-required' : 'pass',
			message:
				artifactIssue ??
				'Build Output API packages the Octane Node handler and static assets for Vercel.',
		});
		checks.push({
			id: 'external-services',
			status: 'action-required',
			message:
				'Provision external PostgreSQL with runtime, background and migrator roles plus verified TLS, an S3-compatible bucket, stable encryption keys, and a completed first-run workspace. Set Vercel environment variables before import.',
		});
		checks.push({
			id: 'worker-schedule',
			status: 'pass',
			message:
				'Vercel Cron ticks the worker Function every minute and a state-changing request ticks it at once. Set CRON_SECRET; on a Hobby plan set FD_VERCEL_CRON_SCHEDULE to a daily schedule, so scheduled automations then wait for traffic or the daily run.',
		});
	} else {
		checks.push({
			id: 'persistent-workers',
			status: 'unsupported',
			message: adapter.summary,
		});
	}
	const renderBlueprintValid =
		checks.find((check) => check.id === 'render-blueprint')?.status === 'pass';
	const deployUrl =
		target === 'render' && renderBlueprintValid
			? renderDeployUrl(workspace.root)
			: target === 'vercel' &&
				  checks.find((check) => check.id === 'vercel-web-artifact')?.status ===
						'pass'
				? vercelDeployUrl(workspace.root)
				: null;
	if (target === 'render' && renderBlueprintValid) {
		checks.push({
			id: 'render-source',
			status: deployUrl ? 'pass' : 'action-required',
			message: deployUrl
				? 'The clean Blueprint and Dockerfile match the current branch recorded under origin.'
				: 'Commit render.yaml and infra/docker/Dockerfile, then push the current branch to a credential-free Git origin before using the Deploy to Render link.',
		});
	}
	if (target === 'vercel') {
		checks.push({
			id: 'vercel-source',
			status: deployUrl ? 'pass' : 'action-required',
			message: deployUrl
				? 'The Vercel build files match the current branch recorded under origin.'
				: 'Commit the Vercel build files and push the branch to a credential-free Git origin before opening the Vercel import link.',
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
						: target === 'vercel'
							? 'See infra/vercel/README.md for the Vercel artifact, its worker ticks and the external services it needs.'
							: null,
		deployUrl,
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
