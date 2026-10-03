import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseArguments } from '../src/arguments.ts';
import { deploymentPlan, runDeployment } from '../src/deployment.ts';
import { runCommand } from '../src/runner.ts';

describe('deployment targets', () => {
	it('refuses to start a request-scoped target even when apply is supplied', async () => {
		for (const target of ['vercel', 'cloudflare']) {
			const result = await runCommand(
				parseArguments(['deploy', 'start', target, '--apply']),
			);
			expect(result.ok).toBe(false);
			expect(result.error?.code).toBe('DEPLOY_TARGET_UNAVAILABLE');
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

	it('only offers a Render button for a credential-free Git origin', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-render-'));
		try {
			execFileSync('git', ['init', '-q', root]);
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
			const plan = await deploymentPlan(workspace, 'render');
			expect((plan.data as { deployUrl: string }).deployUrl).toBe(
				'https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fteam%2Fproject',
			);
			expect(
				(
					plan.data as { checks: { id: string; message: string }[] }
				).checks.find((check) => check.id === 'external-services')?.message,
			).toContain('verify-full');

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
});
