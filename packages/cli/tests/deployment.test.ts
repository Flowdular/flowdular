import {
	access,
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseArguments } from '../src/arguments.ts';
import { deploymentPlan, runDeployment } from '../src/deployment.ts';
import { runCommand } from '../src/runner.ts';
import { findNamedFiles } from '../src/validation.ts';

describe('deployment targets', () => {
	it('refuses to start a target without a verified lifecycle even when apply is supplied', async () => {
		const result = await runCommand(
			parseArguments(['deploy', 'start', 'cloudflare', '--apply']),
		);
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe('DEPLOY_TARGET_UNAVAILABLE');
	});

	it('packages the Octane handler, client assets and module metadata for Vercel', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-vercel-build-'));
		const external = await mkdtemp(
			join(tmpdir(), 'flowdular-vercel-external-'),
		);
		try {
			await mkdir(join(root, 'platform/dist/server/assets'), {
				recursive: true,
			});
			await mkdir(join(root, 'platform/dist/client/assets'), {
				recursive: true,
			});
			await mkdir(join(root, 'modules/example/spec'), { recursive: true });
			await writeFile(
				join(root, 'platform/dist/server/entry.js'),
				'export const nodeHandler = (request, response) => response.end([process.env.NODE_ENV, process.env.FD_DEPLOYMENT_TARGET, process.env.FD_TRUST_PROXY, process.env.FD_AUTH_SECURE_COOKIE, process.env.FD_AUTH_PUBLIC_ORIGIN + request.url].join("|"));\n',
			);
			await writeFile(
				join(root, 'platform/dist/server/index.html'),
				'<html />',
			);
			await writeFile(join(root, 'platform/dist/server/assets/server.js'), '');
			await writeFile(join(root, 'platform/dist/client/assets/app.js'), '');
			await writeFile(
				join(root, 'platform/dist/client/index.html'),
				'<html />',
			);
			await writeFile(join(root, 'platform/package.json'), '{"type":"module"}');
			await writeFile(join(root, 'flowdular.json'), '{"modules":{}}');
			await writeFile(
				join(root, 'modules/example/module.json'),
				'{"id":"example.core"}',
			);
			await writeFile(
				join(root, 'modules/example/spec/module.yaml'),
				'name: Example\n',
			);
			execFileSync(process.execPath, [
				new URL('../../../infra/vercel/build.mjs', import.meta.url).pathname,
				'--package-only',
				'--root',
				root,
			]);
			const output = join(root, '.vercel/output');
			const functionRoot = join(output, 'functions/flowdular.func');
			const config = JSON.parse(
				await readFile(join(output, 'config.json'), 'utf8'),
			) as { version: number; routes: { handle?: string; dest?: string }[] };
			expect(config).toEqual({
				version: 3,
				routes: [
					{ src: '^/api/internal/worker/tick$', dest: '/worker' },
					{ handle: 'filesystem' },
					{ src: '/(.*)', dest: '/flowdular' },
				],
				crons: [{ path: '/api/internal/worker/tick', schedule: '* * * * *' }],
			});
			const workerConfig = JSON.parse(
				await readFile(
					join(output, 'functions/worker.func/.vc-config.json'),
					'utf8',
				),
			) as { maxDuration: number; environment: Record<string, string> };
			expect(workerConfig.environment.FD_RUNTIME_ROLE).toBe('tick');
			expect(workerConfig.maxDuration).toBe(800);
			expect(workerConfig.environment.FD_AGENT_WORKER_DRAIN_MS).toBe('690000');
			expect(
				await readFile(
					join(output, 'functions/worker.func/modules/example/module.json'),
					'utf8',
				),
			).toBe('{"id":"example.core"}');
			const functionConfig = JSON.parse(
				await readFile(join(functionRoot, '.vc-config.json'), 'utf8'),
			) as {
				runtime: string;
				handler: string;
				launcherType: string;
				maxDuration: number;
				environment: Record<string, string>;
			};
			expect(functionConfig.runtime).toBe('nodejs24.x');
			expect(functionConfig.maxDuration).toBe(300);
			expect(
				functionConfig.environment.FD_AGENT_WORKER_DRAIN_MS,
			).toBeUndefined();
			expect(functionConfig.handler).toBe('handler.mjs');
			expect(functionConfig.launcherType).toBe('Nodejs');
			expect(functionConfig.environment.FD_DEPLOYMENT_TARGET).toBe('vercel');
			expect(functionConfig.environment.FD_RUNTIME_ROLE).toBe('web');
			expect(await readFile(join(output, 'static/assets/app.js'), 'utf8')).toBe(
				'',
			);
			expect(
				await readFile(
					join(functionRoot, 'modules/example/spec/module.yaml'),
					'utf8',
				),
			).toBe('name: Example\n');
			expect(await findNamedFiles(root, 'module.yaml')).toEqual([
				join(root, 'modules/example/spec/module.yaml'),
			]);
			await expect(access(join(output, 'static/index.html'))).rejects.toThrow();
			await expect(
				access(join(output, 'static/flowdular.json')),
			).rejects.toThrow();
			const smoke = spawnSync(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`const { default: handler } = await import(${JSON.stringify(pathToFileURL(join(functionRoot, 'handler.mjs')).href)}); handler({ url: '/api/health' }, { end: (value) => process.stdout.write(value) });`,
				],
				{
					encoding: 'utf8',
					env: {
						...process.env,
						NODE_ENV: 'development',
						FD_DEPLOYMENT_TARGET: 'local',
						FD_TRUST_PROXY: 'false',
						FD_AUTH_SECURE_COOKIE: 'false',
						FD_AUTH_PUBLIC_ORIGIN: '',
						VERCEL_URL: 'preview.vercel.app',
					},
				},
			);
			expect(smoke.status).toBe(0);
			expect(smoke.stdout).toBe(
				'production|vercel|true|true|https://preview.vercel.app/api/health',
			);
			await writeFile(join(root, 'secret.txt'), 'private');
			await symlink(
				join(root, 'secret.txt'),
				join(root, 'platform/dist/server/assets/secret.txt'),
			);
			const unsafeBuild = spawnSync(
				process.execPath,
				[
					new URL('../../../infra/vercel/build.mjs', import.meta.url).pathname,
					'--package-only',
					'--root',
					root,
				],
				{ encoding: 'utf8' },
			);
			expect(unsafeBuild.status).not.toBe(0);
			expect(unsafeBuild.stderr).toContain('must be a regular file');
			await rm(join(root, 'platform/dist/server/assets/secret.txt'));
			await writeFile(join(external, 'module.yaml'), 'secret: private\n');
			await rm(join(root, 'modules/example/spec'), {
				recursive: true,
				force: true,
			});
			await symlink(external, join(root, 'modules/example/spec'), 'dir');
			const escapedBuild = spawnSync(
				process.execPath,
				[
					new URL('../../../infra/vercel/build.mjs', import.meta.url).pathname,
					'--package-only',
					'--root',
					root,
				],
				{ encoding: 'utf8' },
			);
			expect(escapedBuild.status).not.toBe(0);
			expect(escapedBuild.stderr).toContain('must stay inside');
			await rm(join(root, 'modules/example/spec'));
			await mkdir(join(root, 'modules/example/spec'));
			await writeFile(
				join(root, 'modules/example/spec/module.yaml'),
				'name: Example\n',
			);
			await rm(join(root, '.vercel'), { recursive: true, force: true });
			await writeFile(join(external, 'keep.txt'), 'keep');
			await symlink(external, join(root, '.vercel'), 'dir');
			const redirectedBuild = spawnSync(
				process.execPath,
				[
					new URL('../../../infra/vercel/build.mjs', import.meta.url).pathname,
					'--package-only',
					'--root',
					root,
				],
				{ encoding: 'utf8' },
			);
			expect(redirectedBuild.status).not.toBe(0);
			expect(redirectedBuild.stderr).toContain(
				'.vercel must be a directory inside the workspace',
			);
			expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('keep');
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(external, { recursive: true, force: true });
		}
	});

	it('fits the cron schedule and worker duration to the Vercel plan', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-vercel-cron-'));
		try {
			await mkdir(join(root, 'platform/dist/server'), { recursive: true });
			await mkdir(join(root, 'platform/dist/client/assets'), {
				recursive: true,
			});
			await mkdir(join(root, 'modules'), { recursive: true });
			await writeFile(join(root, 'platform/dist/server/entry.js'), '');
			await writeFile(join(root, 'platform/package.json'), '{}');
			await writeFile(join(root, 'flowdular.json'), '{}');
			const build = (environment: Record<string, string>) =>
				spawnSync(
					process.execPath,
					[
						new URL('../../../infra/vercel/build.mjs', import.meta.url)
							.pathname,
						'--package-only',
						'--root',
						root,
					],
					{
						encoding: 'utf8',
						env: {
							...process.env,
							FD_VERCEL_PLAN: '',
							FD_VERCEL_CRON_SCHEDULE: '',
							FD_WORKER_TICK_WINDOW_MS: '',
							...environment,
						},
					},
				);
			const output = async () => ({
				crons: (
					JSON.parse(
						await readFile(join(root, '.vercel/output/config.json'), 'utf8'),
					) as { crons: { schedule: string }[] }
				).crons,
				worker: JSON.parse(
					await readFile(
						join(root, '.vercel/output/functions/worker.func/.vc-config.json'),
						'utf8',
					),
				) as { maxDuration: number; environment: Record<string, string> },
			});
			expect(build({ FD_VERCEL_PLAN: 'hobby' }).status).toBe(0);
			const hobby = await output();
			expect(hobby.crons).toEqual([
				{ path: '/api/internal/worker/tick', schedule: '0 3 * * *' },
			]);
			expect(hobby.worker.maxDuration).toBe(300);
			expect(hobby.worker.environment.FD_AGENT_WORKER_DRAIN_MS).toBe('180000');
			expect(
				build({ FD_VERCEL_PLAN: 'pro', FD_VERCEL_CRON_SCHEDULE: '*/5 * * * *' })
					.status,
			).toBe(0);
			expect((await output()).crons).toEqual([
				{ path: '/api/internal/worker/tick', schedule: '*/5 * * * *' },
			]);
			const unknownPlan = build({ FD_VERCEL_PLAN: 'free' });
			expect(unknownPlan.status).not.toBe(0);
			expect(unknownPlan.stderr).toContain(
				'FD_VERCEL_PLAN must be "hobby" or "pro".',
			);
			const longWindow = build({
				FD_VERCEL_PLAN: 'hobby',
				FD_WORKER_TICK_WINDOW_MS: '120000',
			});
			expect(longWindow.status).not.toBe(0);
			expect(longWindow.stderr).toContain('300 second hobby limit');
			const malformed = build({ FD_VERCEL_CRON_SCHEDULE: 'every minute' });
			expect(malformed.status).not.toBe(0);
			expect(malformed.stderr).toContain(
				'FD_VERCEL_CRON_SCHEDULE must be a five-field cron expression.',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('kicks the worker function after a successful state change in the web role', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-vercel-kick-'));
		const received: {
			method: string | undefined;
			url: string | undefined;
			auth: string | undefined;
		}[] = [];
		const server = createServer((request, response) => {
			received.push({
				method: request.method,
				url: request.url,
				auth: request.headers.authorization,
			});
			response.end('{}');
		});
		await new Promise<void>((resolve) =>
			server.listen(0, '127.0.0.1', resolve),
		);
		try {
			await mkdir(join(root, 'platform/dist/server'), { recursive: true });
			await writeFile(
				join(root, 'platform/dist/server/entry.js'),
				'export const nodeHandler = (request, response) => { response.statusCode = request.status; };\n',
			);
			await copyFile(
				new URL('../../../infra/vercel/handler.mjs', import.meta.url),
				join(root, 'handler.mjs'),
			);
			const { port } = server.address() as AddressInfo;
			const kicksFor = async (method: string, url: string, status: number) => {
				const before = received.length;
				const script = `
					import { EventEmitter } from 'node:events';
					const pending = [];
					globalThis[Symbol.for('@vercel/request-context')] = {
						get: () => ({ waitUntil: (promise) => pending.push(promise) }),
					};
					const { default: handler } = await import(${JSON.stringify(pathToFileURL(join(root, 'handler.mjs')).href)});
					const response = new EventEmitter();
					handler(${JSON.stringify({ method, url, status })}, response);
					response.emit('close');
					await Promise.all(pending);
				`;
				const run = await promisify(execFile)(
					process.execPath,
					['--input-type=module', '-e', script],
					{
						env: {
							...process.env,
							FD_RUNTIME_ROLE: 'web',
							FD_AUTH_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
							FD_WORKER_TICK_SECRET: '',
							CRON_SECRET: 'c'.repeat(32),
						},
					},
				);
				expect(run.stderr).toBe('');
				return received.length - before;
			};
			expect(await kicksFor('GET', '/api/records', 200)).toBe(0);
			expect(await kicksFor('POST', '/api/records', 403)).toBe(0);
			expect(await kicksFor('POST', '/settings', 200)).toBe(0);
			expect(await kicksFor('POST', '/api/records', 201)).toBe(1);
			expect(received.at(-1)).toEqual({
				method: 'POST',
				url: '/api/internal/worker/tick',
				auth: `Bearer ${'c'.repeat(32)}`,
			});
		} finally {
			await new Promise((resolve) => server.close(resolve));
			await rm(root, { recursive: true, force: true });
		}
	});

	it('hands Octane an https request target so same-origin checks match the browser', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-vercel-origin-'));
		try {
			await mkdir(join(root, 'platform/dist/server'), { recursive: true });
			await writeFile(
				join(root, 'platform/dist/server/entry.js'),
				'export const nodeHandler = (request, response) => { response.url = request.url; };\n',
			);
			await copyFile(
				new URL('../../../infra/vercel/handler.mjs', import.meta.url),
				join(root, 'handler.mjs'),
			);
			const script = `
				const { default: handler } = await import(${JSON.stringify(pathToFileURL(join(root, 'handler.mjs')).href)});
				const seen = [];
				for (const request of [
					{ method: 'POST', url: '/api/auth/sign-in?next=%2Fapp', headers: { host: 'flowdular-test.vercel.app' } },
					{ method: 'GET', url: '/api/health' },
				]) {
					const response = { once() {} };
					handler(request, response);
					seen.push(response.url);
				}
				process.stdout.write(JSON.stringify(seen));
			`;
			const run = await promisify(execFile)(
				process.execPath,
				['--input-type=module', '-e', script],
				{ env: { ...process.env, FD_RUNTIME_ROLE: 'tick' } },
			);
			const [signIn, bare] = JSON.parse(run.stdout) as string[];
			/* The base Octane's Node adapter applies to every request target. */
			const url = new URL(signIn!, 'http://flowdular-test.vercel.app');
			expect(url.origin).toBe('https://flowdular-test.vercel.app');
			expect(url.pathname + url.search).toBe('/api/auth/sign-in?next=%2Fapp');
			expect(bare).toBe('/api/health');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('returns an import link only for pushed Vercel build sources', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-vercel-plan-'));
		try {
			execFileSync('git', ['init', '-q', '-b', 'feat/vercel', root]);
			execFileSync('git', ['config', 'user.email', 'test@example.test'], {
				cwd: root,
			});
			execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
			execFileSync(
				'git',
				['remote', 'add', 'origin', 'git@github.com:team/project.git'],
				{ cwd: root },
			);
			const workspace = {
				root,
				configPath: join(root, 'flowdular.json'),
				config: {},
			};
			const missing = await deploymentPlan(workspace, 'vercel');
			expect(
				(missing.data as { deployUrl: string | null }).deployUrl,
			).toBeNull();
			await mkdir(join(root, 'infra/vercel'), { recursive: true });
			await mkdir(join(root, 'platform'), { recursive: true });
			await writeFile(
				join(root, 'vercel.json'),
				'{"framework":null,"buildCommand":"node infra/vercel/build.mjs"}',
			);
			for (const path of [
				'infra/vercel/build.mjs',
				'infra/vercel/handler.mjs',
				'platform/package.json',
				'platform/octane.config.ts',
			])
				await writeFile(join(root, path), 'fixture');
			const local = await deploymentPlan(workspace, 'vercel');
			expect((local.data as { deployUrl: string | null }).deployUrl).toBeNull();
			execFileSync('git', ['add', '.'], { cwd: root });
			execFileSync('git', ['commit', '-q', '-m', 'Add Vercel web build'], {
				cwd: root,
			});
			execFileSync(
				'git',
				['update-ref', 'refs/remotes/origin/feat/vercel', 'HEAD'],
				{ cwd: root },
			);
			const pushed = await deploymentPlan(workspace, 'vercel');
			const data = pushed.data as {
				status: string;
				deployUrl: string | null;
				checks: { id: string; status: string }[];
			};
			expect(data.deployUrl).toBe(
				'https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fteam%2Fproject%2Ftree%2Ffeat%2Fvercel',
			);
			expect(data.status).toBe('action-required');
			expect(
				data.checks.find((check) => check.id === 'vercel-web-artifact')?.status,
			).toBe('pass');
			expect(
				data.checks.find((check) => check.id === 'worker-schedule')?.status,
			).toBe('pass');
			expect(
				data.checks.find((check) => check.id === 'external-services')?.status,
			).toBe('pass');
			await writeFile(join(root, 'vercel.json'), '{}');
			const malformed = await deploymentPlan(workspace, 'vercel');
			expect(
				(malformed.data as { deployUrl: string | null }).deployUrl,
			).toBeNull();
			await writeFile(
				join(root, 'vercel.json'),
				'{"framework":null,"buildCommand":"node infra/vercel/build.mjs"}',
			);
			execFileSync(
				'git',
				[
					'remote',
					'set-url',
					'origin',
					'https://token:secret@github.com/team/project.git',
				],
				{ cwd: root },
			);
			const protectedPlan = await deploymentPlan(workspace, 'vercel');
			expect(
				(protectedPlan.data as { deployUrl: string | null }).deployUrl,
			).toBeNull();
			expect(JSON.stringify(protectedPlan.data)).not.toContain('secret');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('exposes a read-only plan and requires a private terminal for launch', async () => {
		const plan = await runCommand(
			parseArguments(['deploy', 'start', 'docker']),
		);
		expect(plan.ok).toBe(true);
		expect((plan.data as { target: string }).target).toBe('docker');

		const refused = await runCommand(
			parseArguments(['deploy', 'start', 'docker', '--apply', '--json']),
		);
		expect(refused.ok).toBe(false);
		expect(refused.error?.code).toBe('INTERACTIVE_OUTPUT_REQUIRED');

		const redirected = await runDeployment(
			{ root: process.cwd(), configPath: '', config: {} },
			'start',
			'docker',
			parseArguments(['deploy', 'start', 'docker', '--apply']),
			{ input: true, output: false, errors: true },
		);
		expect(redirected.error?.code).toBe('INTERACTIVE_TERMINAL_REQUIRED');
	});

	it('does not accept a launcher symlink outside the workspace', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-deploy-'));
		const external = await mkdtemp(join(tmpdir(), 'flowdular-external-'));
		try {
			await writeFile(join(external, 'start.mjs'), '');
			await mkdir(join(root, 'infra/docker'), { recursive: true });
			await symlink(
				join(external, 'start.mjs'),
				join(root, 'infra/docker/start.mjs'),
			);
			const workspace = {
				root,
				configPath: join(root, 'flowdular.json'),
				config: {},
			};
			const plan = await deploymentPlan(workspace, 'docker');
			const checks = (plan.data as { checks: { id: string; status: string }[] })
				.checks;
			expect(
				checks.find((check) => check.id === 'infra/docker/start.mjs')?.status,
			).toBe('action-required');
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(external, { recursive: true, force: true });
		}
	});

	it('blocks Docker start when Compose exists but its daemon is unavailable', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-deploy-'));
		const binaryDirectory = await mkdtemp(join(tmpdir(), 'flowdular-bin-'));
		const originalPath = process.env.PATH;
		try {
			await mkdir(join(root, 'infra/docker'), { recursive: true });
			for (const name of [
				'Dockerfile',
				'compose.yaml',
				'.env.example',
				'start.mjs',
			]) {
				await writeFile(join(root, 'infra/docker', name), 'fixture');
			}
			const fakeDocker = join(binaryDirectory, 'docker');
			await writeFile(
				fakeDocker,
				'#!/bin/sh\nif [ "$1" = "compose" ]; then exit 0; fi\nexit 1\n',
			);
			await chmod(fakeDocker, 0o755);
			process.env.PATH = `${binaryDirectory}:${originalPath ?? ''}`;
			const workspace = {
				root,
				configPath: join(root, 'flowdular.json'),
				config: {},
			};
			const plan = await deploymentPlan(workspace, 'docker');
			const data = plan.data as {
				status: string;
				checks: { id: string; status: string }[];
			};
			expect(
				data.checks.find((check) => check.id === 'docker-compose')?.status,
			).toBe('pass');
			expect(
				data.checks.find((check) => check.id === 'docker-daemon')?.status,
			).toBe('action-required');
			expect(data.status).toBe('action-required');
			const start = await runDeployment(
				workspace,
				'start',
				'docker',
				parseArguments(['deploy', 'start', 'docker', '--apply']),
				{ input: true, output: true, errors: true },
			);
			expect(start.error?.code).toBe('DEPLOY_PREFLIGHT_FAILED');
			await expect(
				access(join(root, '.flowdular/deployments.json')),
			).rejects.toThrow();
		} finally {
			process.env.PATH = originalPath;
			await rm(root, { recursive: true, force: true });
			await rm(binaryDirectory, { recursive: true, force: true });
		}
	});

	it('ships a persistent Render service in the generated project', async () => {
		const file = new URL(
			'../../create-flowdular/template/default/render.yaml',
			import.meta.url,
		);
		const blueprint = parse(await readFile(file, 'utf8')) as {
			services: {
				runtime: string;
				plan: string;
				dockerfilePath: string;
				envVars: {
					key: string;
					sync?: boolean;
					generateValue?: boolean;
					fromService?: { name: string; type: string; envVarKey: string };
				}[];
			}[];
		};
		expect(blueprint.services).toHaveLength(1);
		const service = blueprint.services[0]!;
		expect(service.runtime).toBe('docker');
		expect(service.plan).not.toBe('free');
		expect(service.dockerfilePath).toBe('./infra/docker/Dockerfile');
		for (const key of [
			'FD_DATABASE_URL',
			'FD_DATABASE_BACKGROUND_URL',
			'FD_DATABASE_MIGRATOR_URL',
			'FD_STORAGE_S3_SECRET_ACCESS_KEY',
		]) {
			expect(service.envVars.find((entry) => entry.key === key)?.sync).toBe(
				false,
			);
		}
		expect(
			service.envVars.find((entry) => entry.key === 'FD_AUTH_PUBLIC_ORIGIN')
				?.fromService,
		).toEqual({
			name: 'flowdular',
			type: 'web',
			envVarKey: 'RENDER_EXTERNAL_URL',
		});
		for (const key of [
			'FD_AGENT_CREDENTIAL_KEY',
			'FD_STORAGE_ENCRYPTION_KEY',
		]) {
			expect(
				service.envVars.find((entry) => entry.key === key)?.generateValue,
			).toBe(true);
		}
	});

	it('only offers a Render button for a valid Blueprint on a pushed branch', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-render-'));
		try {
			execFileSync('git', [
				'init',
				'-q',
				'-b',
				'feat/deployment-capabilities',
				root,
			]);
			await writeFile(join(root, 'render.yaml'), 'services: []\n');
			execFileSync(
				'git',
				['remote', 'add', 'origin', 'git@github.com:team/project.git'],
				{ cwd: root },
			);
			const workspace = {
				root,
				configPath: join(root, 'flowdular.json'),
				config: {},
			};
			const invalid = await deploymentPlan(workspace, 'render');
			expect(
				(invalid.data as { deployUrl: string | null }).deployUrl,
			).toBeNull();
			expect(
				(
					invalid.data as { checks: { id: string; status: string }[] }
				).checks.find((check) => check.id === 'render-blueprint')?.status,
			).toBe('action-required');
			await writeFile(join(root, 'render.yaml'), 'services: [\n');
			const malformed = await deploymentPlan(workspace, 'render');
			expect(
				(malformed.data as { deployUrl: string | null }).deployUrl,
			).toBeNull();
			expect(
				(
					malformed.data as { checks: { id: string; status: string }[] }
				).checks.find((check) => check.id === 'render-blueprint')?.status,
			).toBe('action-required');
			await writeFile(
				join(root, 'render.yaml'),
				await readFile(
					new URL(
						'../../create-flowdular/template/default/render.yaml',
						import.meta.url,
					),
					'utf8',
				),
			);
			const missingDockerfile = await deploymentPlan(workspace, 'render');
			expect(
				(
					missingDockerfile.data as { checks: { id: string; status: string }[] }
				).checks.find((check) => check.id === 'render-blueprint')?.status,
			).toBe('action-required');
			await mkdir(join(root, 'infra/docker'), { recursive: true });
			await writeFile(join(root, 'infra/docker/Dockerfile'), 'FROM node:24\n');
			const localOnly = await deploymentPlan(workspace, 'render');
			expect(
				(localOnly.data as { deployUrl: string | null }).deployUrl,
			).toBeNull();
			execFileSync('git', ['config', 'user.email', 'test@example.test'], {
				cwd: root,
			});
			execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
			execFileSync('git', ['add', 'render.yaml'], { cwd: root });
			execFileSync('git', ['commit', '-q', '-m', 'Add Render Blueprint'], {
				cwd: root,
			});
			execFileSync(
				'git',
				[
					'update-ref',
					'refs/remotes/origin/feat/deployment-capabilities',
					'HEAD',
				],
				{ cwd: root },
			);
			const untrackedDockerfile = await deploymentPlan(workspace, 'render');
			expect(
				(untrackedDockerfile.data as { deployUrl: string | null }).deployUrl,
			).toBeNull();
			execFileSync('git', ['add', 'infra/docker/Dockerfile'], { cwd: root });
			execFileSync('git', ['commit', '-q', '-m', 'Add Dockerfile'], {
				cwd: root,
			});
			execFileSync(
				'git',
				[
					'update-ref',
					'refs/remotes/origin/feat/deployment-capabilities',
					'HEAD',
				],
				{ cwd: root },
			);
			const plan = await deploymentPlan(workspace, 'render');
			expect((plan.data as { deployUrl: string }).deployUrl).toBe(
				'https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fteam%2Fproject%2Ftree%2Ffeat%2Fdeployment-capabilities',
			);
			expect(
				(
					plan.data as { checks: { id: string; message: string }[] }
				).checks.find((check) => check.id === 'external-services')?.message,
			).toContain('verify-full');
			await writeFile(join(root, 'infra/docker/Dockerfile'), 'FROM node:22\n');
			const changedDockerfile = await deploymentPlan(workspace, 'render');
			expect(
				(changedDockerfile.data as { deployUrl: string | null }).deployUrl,
			).toBeNull();
			execFileSync('git', ['restore', 'infra/docker/Dockerfile'], {
				cwd: root,
			});
			const generatedBlueprint = await readFile(
				join(root, 'render.yaml'),
				'utf8',
			);
			const customDomainBlueprint = generatedBlueprint.replace(
				'fromService:\n          name: flowdular\n          type: web\n          envVarKey: RENDER_EXTERNAL_URL',
				'value: https://flow.example.test',
			);
			expect(customDomainBlueprint).not.toBe(generatedBlueprint);
			await writeFile(join(root, 'render.yaml'), customDomainBlueprint);
			const customDomain = await deploymentPlan(workspace, 'render');
			expect(
				(
					customDomain.data as { checks: { id: string; status: string }[] }
				).checks.find((check) => check.id === 'render-blueprint')?.status,
			).toBe('pass');
			await writeFile(
				join(root, 'render.yaml'),
				generatedBlueprint.replace(
					'fromService:\n          name: flowdular\n          type: web\n          envVarKey: RENDER_EXTERNAL_URL',
					'value: http://flow.example.test',
				),
			);
			const insecureDomain = await deploymentPlan(workspace, 'render');
			expect(
				(
					insecureDomain.data as { checks: { id: string; status: string }[] }
				).checks.find((check) => check.id === 'render-blueprint')?.status,
			).toBe('action-required');
			execFileSync('git', ['restore', 'render.yaml'], { cwd: root });
			await writeFile(
				join(root, 'render.yaml'),
				(await readFile(join(root, 'render.yaml'), 'utf8')).replace(
					'      - key: FD_DATABASE_MIGRATOR_URL\n        sync: false\n',
					'',
				),
			);
			const missingRole = await deploymentPlan(workspace, 'render');
			expect(
				(missingRole.data as { deployUrl: string | null }).deployUrl,
			).toBeNull();
			expect(
				(
					missingRole.data as { checks: { id: string; status: string }[] }
				).checks.find((check) => check.id === 'render-blueprint')?.status,
			).toBe('action-required');
			execFileSync('git', ['restore', 'render.yaml'], { cwd: root });

			execFileSync(
				'git',
				[
					'remote',
					'set-url',
					'origin',
					'https://token:secret@github.com/team/project.git',
				],
				{ cwd: root },
			);
			const protectedPlan = await deploymentPlan(workspace, 'render');
			expect(
				(protectedPlan.data as { deployUrl: string | null }).deployUrl,
			).toBeNull();
			expect(JSON.stringify(protectedPlan.data)).not.toContain('secret');
			execFileSync(
				'git',
				['remote', 'set-url', 'origin', 'git@github.com:team/project.git'],
				{ cwd: root },
			);
			await writeFile(join(root, 'other.txt'), 'new commit\n');
			execFileSync('git', ['add', 'other.txt'], { cwd: root });
			execFileSync('git', ['commit', '-q', '-m', 'Later change'], {
				cwd: root,
			});
			const unpushed = await deploymentPlan(workspace, 'render');
			expect(
				(unpushed.data as { deployUrl: string | null }).deployUrl,
			).toBeNull();
			await writeFile(join(root, 'render.yaml'), 'services: []\n');
			const changed = await deploymentPlan(workspace, 'render');
			expect(
				(changed.data as { deployUrl: string | null }).deployUrl,
			).toBeNull();
			await rm(join(root, 'render.yaml'));
			const missing = await deploymentPlan(workspace, 'render');
			expect(
				(missing.data as { deployUrl: string | null }).deployUrl,
			).toBeNull();
			expect(
				(
					missing.data as { checks: { id: string; status: string }[] }
				).checks.find((check) => check.id === 'render-blueprint')?.status,
			).toBe('action-required');
			execFileSync('git', ['restore', 'render.yaml'], { cwd: root });
			execFileSync('git', ['rm', '--cached', '-q', 'render.yaml'], {
				cwd: root,
			});
			await writeFile(join(root, '.gitignore'), 'render.yaml\n');
			execFileSync('git', ['add', '.gitignore'], { cwd: root });
			execFileSync('git', ['commit', '-q', '-m', 'Ignore Blueprint'], {
				cwd: root,
			});
			execFileSync(
				'git',
				[
					'update-ref',
					'refs/remotes/origin/feat/deployment-capabilities',
					'HEAD',
				],
				{ cwd: root },
			);
			expect(
				execFileSync('git', ['status', '--porcelain', '--', 'render.yaml'], {
					cwd: root,
					encoding: 'utf8',
				}),
			).toBe('');
			const ignored = await deploymentPlan(workspace, 'render');
			expect(
				(ignored.data as { deployUrl: string | null }).deployUrl,
			).toBeNull();
			expect(
				(
					ignored.data as { checks: { id: string; status: string }[] }
				).checks.find((check) => check.id === 'render-blueprint')?.status,
			).toBe('pass');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('records a bounded local deployment receipt without credentials', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-deploy-'));
		const binaryDirectory = await mkdtemp(join(tmpdir(), 'flowdular-bin-'));
		const originalPath = process.env.PATH;
		try {
			await mkdir(join(root, 'infra/docker'), { recursive: true });
			for (const name of ['Dockerfile', 'compose.yaml', '.env.example']) {
				await writeFile(join(root, 'infra/docker', name), 'fixture');
			}
			await writeFile(
				join(root, 'infra/docker/start.mjs'),
				"import {writeFileSync} from 'node:fs'; writeFileSync('started', 'yes');",
			);
			const fakeDocker = join(binaryDirectory, 'docker');
			await writeFile(fakeDocker, '#!/bin/sh\nexit 0\n');
			await chmod(fakeDocker, 0o755);
			process.env.PATH = `${binaryDirectory}:${originalPath ?? ''}`;
			const workspace = {
				root,
				configPath: join(root, 'flowdular.json'),
				config: {},
			};
			const result = await runDeployment(
				workspace,
				'start',
				'docker',
				parseArguments(['deploy', 'start', 'docker', '--apply']),
				{ input: true, output: true, errors: true },
			);
			expect(result.ok).toBe(true);
			expect(await readFile(join(root, 'started'), 'utf8')).toBe('yes');
			const journal = JSON.parse(
				await readFile(join(root, '.flowdular/deployments.json'), 'utf8'),
			) as { auditId: string; outcome: string; target: string }[];
			expect(journal).toEqual([
				{
					auditId: result.auditId,
					outcome: 'started',
					target: 'docker',
					createdAt: expect.any(String),
				},
			]);
		} finally {
			process.env.PATH = originalPath;
			await rm(root, { recursive: true, force: true });
			await rm(binaryDirectory, { recursive: true, force: true });
		}
	});

	it('records an unknown outcome and releases the lock after launcher failure', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-deploy-'));
		const binaryDirectory = await mkdtemp(join(tmpdir(), 'flowdular-bin-'));
		const originalPath = process.env.PATH;
		try {
			await mkdir(join(root, 'infra/docker'), { recursive: true });
			for (const name of ['Dockerfile', 'compose.yaml', '.env.example']) {
				await writeFile(join(root, 'infra/docker', name), 'fixture');
			}
			const launcher = join(root, 'infra/docker/start.mjs');
			await writeFile(launcher, 'process.exit(1)');
			const fakeDocker = join(binaryDirectory, 'docker');
			await writeFile(fakeDocker, '#!/bin/sh\nexit 0\n');
			await chmod(fakeDocker, 0o755);
			process.env.PATH = `${binaryDirectory}:${originalPath ?? ''}`;
			const workspace = {
				root,
				configPath: join(root, 'flowdular.json'),
				config: {},
			};
			const first = await runDeployment(
				workspace,
				'start',
				'docker',
				parseArguments(['deploy', 'start', 'docker', '--apply']),
				{ input: true, output: true, errors: true },
			);
			expect(first.error?.code).toBe('DEPLOY_START_FAILED');
			expect(first.auditId).toBeTypeOf('string');
			const journal = JSON.parse(
				await readFile(join(root, '.flowdular/deployments.json'), 'utf8'),
			) as { auditId: string; outcome: string }[];
			expect(journal[0]).toMatchObject({
				auditId: first.auditId,
				outcome: 'unknown',
			});
			await expect(
				access(join(root, '.flowdular/deployment.lock')),
			).rejects.toThrow();
			await writeFile(launcher, 'process.exit(0)');
			const retry = await runDeployment(
				workspace,
				'start',
				'docker',
				parseArguments(['deploy', 'start', 'docker', '--apply']),
				{ input: true, output: true, errors: true },
			);
			expect(retry.ok).toBe(true);
		} finally {
			process.env.PATH = originalPath;
			await rm(root, { recursive: true, force: true });
			await rm(binaryDirectory, { recursive: true, force: true });
		}
	});
});
