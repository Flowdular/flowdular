import { createHash } from 'node:crypto';
import {
	mkdtemp,
	stat,
	readFile,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectAutoReview, moduleReviewRevision } from '../auto-review.ts';
import { modulePathOf, sessionPaths } from '../sessions.ts';
import { gitDeliveryRunner } from './git-pr.ts';
import {
	GATES,
	assertEjectCapability,
	countDeliveredFiles,
	planSessionModules,
} from './plan.ts';
import {
	DeliveryError,
	createStepRecorder,
	exists,
	runDeliveryGates,
	stageModules,
} from './steps.ts';
import type { DeliveryContext, DeliveryTarget } from './types.ts';

export const OFFICIAL_MODULES_REPOSITORY = 'Flowdular/official-modules';
const REPOSITORY = OFFICIAL_MODULES_REPOSITORY;
const active = new Set<string>();
const ROOT_FILES = new Set([
	'module.json',
	'package.json',
	'README.md',
	'CHANGELOG.md',
	'LICENSE',
	'tsconfig.json',
	'vitest.config.ts',
]);
const ROOTS = new Set(['src', 'tests', 'migrations', 'translations', 'spec']);

function fail(message: string): never {
	throw new DeliveryError('OFFICIAL_MODULES_BLOCKED', message);
}

/* Reject extra files rather than silently publishing a subset of what was reviewed. */
export function assertOfficialSourcePaths(files: readonly string[]): void {
	if (files.length > 4096) fail('The contribution exceeds 4096 source files.');
	for (const file of files) {
		const parts = file.split('/');
		if (
			file.length >= 240 ||
			!/^[a-zA-Z0-9_./@+ -]+$/.test(file) ||
			parts.some(
				(part) =>
					!part ||
					part.startsWith('.') ||
					part === 'node_modules' ||
					part === 'dist',
			) ||
			!(parts.length === 1 ? ROOT_FILES.has(file) : ROOTS.has(parts[0]!))
		) {
			fail(
				`Unsupported registry source path: ${file}. Remove private or generated files before review.`,
			);
		}
	}
}

async function reviewedPlan(context: DeliveryContext) {
	assertEjectCapability(context);
	if (
		context.session.modules.length !== 1 ||
		context.session.modules[0]!.kind !== 'new'
	)
		fail(
			'Submit one new module at a time. Existing registry modules need a contributor branch and compatibility review.',
		);
	const modules = (await planSessionModules(context)).map((module) => ({
		...module,
		enable: false,
	}));
	const paths = sessionPaths(
		context.workspaceRoot,
		context.session.id,
		context.session.moduleSuffix,
	);
	for (const module of modules) {
		assertOfficialSourcePaths(module.files);
		if (
			!/^[a-z][a-z0-9-]*$/.test(module.directory) ||
			!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(module.id)
		)
			fail('Invalid module identity.');
		let bytes = 0;
		for (const file of module.files) {
			bytes += (await stat(join(modulePathOf(paths, module.directory), file)))
				.size;
			if (bytes > 32 * 1024 * 1024) fail('The contribution exceeds 32 MiB.');
		}

		const review = await inspectAutoReview(paths, module);
		if (!review.passed) fail(review.output);
	}
	return modules;
}

/* This script runs only after the cloned registry's actual verification passes.
   It uses its pinned distribution API, so hashing and packaging share a contract. */
const REVIEW_SCRIPT = `
import { mkdir, writeFile } from 'node:fs/promises';
import { readModuleSource, sourceDigest } from 'flowdular/distribution';
const [directory, id, revision] = process.argv.slice(1);
const sourceSha256 = sourceDigest(await readModuleSource(directory));
await mkdir('reviews', {recursive:true});
await writeFile('reviews/' + id + '.json', JSON.stringify({
 sourceSha256,
 requirements: ['Implement the human-approved specification in ' + directory + '/spec/module.yaml',
  'Pass all sandbox gates and exact-source auto-review ' + revision,
  'Pass the official repository verification against the pinned SDK'],
 findings: [],
 checks: ['typecheck','test','validate'].map(name => ({name,command:'pnpm ' + name,exitCode:0}))
}, null, '\\t') + '\\n');
`;

export function createOfficialModulesDeliveryTarget(): DeliveryTarget {
	return {
		id: 'official-modules',
		available: async (context) => {
			try {
				await reviewedPlan(context);
				const run = await gitDeliveryRunner(context);
				const result = await run(
					'gh',
					['api', `repos/${REPOSITORY}`, '--jq', '.full_name'],
					context.workspaceRoot,
				);
				if (
					result.code !== 0 ||
					result.output.trim().toLowerCase() !== REPOSITORY.toLowerCase()
				)
					return {
						available: false,
						reason:
							'GitHub authentication and access to Flowdular/official-modules are required.',
					};
				return { available: true, reason: null };
			} catch (error) {
				return {
					available: false,
					reason:
						error instanceof Error
							? error.message
							: 'A reviewed new module is required.',
				};
			}
		},
		plan: async (context) => {
			const modules = await reviewedPlan(context);
			const primary = modules[0]!;
			return {
				target: 'official-modules',
				deliveredBy: 'official-modules',
				moduleId: primary.id,
				targetPath: primary.targetPath,
				files: primary.files,
				overwrites: [],
				removes: [],
				newPackages: primary.newPackages,
				enable: false,
				modules,
				changedFiles: countDeliveredFiles(modules),
				gates: [...GATES],
				platformLocal: false,
				restartRequired: false,
				notes: [
					`Open a PR to ${REPOSITORY}/main after sandbox review and registry verification. The module sources, tests and approved specification will be shared with that repository. Maintainers publish the registry after acceptance.`,
				],
				applied: false,
			};
		},
		apply: async (context, plan, emit) => {
			if (plan.target !== 'official-modules')
				fail('The plan targets another repository.');
			const key = `${context.workspaceRoot}:${context.session.id}`;
			if (active.has(key)) fail('This contribution is already running.');
			active.add(key);
			let scratch: string | undefined;
			try {
				const modules = await reviewedPlan(context);
				const module = modules[0]!;
				const paths = sessionPaths(
					context.workspaceRoot,
					context.session.id,
					context.session.moduleSuffix,
				);
				const source = modulePathOf(paths, module.directory);
				const revision = await moduleReviewRevision(source);
				const gates = await runDeliveryGates(context, GATES, emit);
				const run = await gitDeliveryRunner(context);
				const recorder = createStepRecorder(emit);
				const command = async (
					id: string,
					executable: string,
					args: string[],
					cwd: string,
				) => {
					emit(`${id}.started`, {});
					const result = await run(executable, args, cwd);
					recorder.record(id, { ok: result.code === 0, output: result.output });
					return result.output.trim();
				};
				scratch = await mkdtemp(join(tmpdir(), 'flowdular-official-'));
				const checkout = join(scratch, 'registry');
				await command(
					'worktree',
					'git',
					[
						'clone',
						'--quiet',
						'--depth',
						'1',
						'--branch',
						'main',
						`https://github.com/${REPOSITORY}.git`,
						checkout,
					],
					scratch,
				);
				if (await exists(join(checkout, module.targetPath)))
					fail(
						'That module directory already exists in Official Modules. Use a contributor branch for updates.',
					);
				for (const entry of await readdir(join(checkout, 'modules'), {
					withFileTypes: true,
				})) {
					if (!entry.isDirectory()) continue;
					const manifest = JSON.parse(
						await readFile(
							join(checkout, 'modules', entry.name, 'module.json'),
							'utf8',
						),
					);
					if (manifest.id === module.id)
						fail('That module ID already exists in Official Modules.');
				}
				const { copied } = await stageModules(paths, checkout, modules, emit);
				const staged = join(checkout, module.targetPath);
				if ((await moduleReviewRevision(staged)) !== revision)
					fail('Source changed during staging. Repeat review.');
				await command(
					'install',
					'pnpm',
					['install', '--no-frozen-lockfile'],
					checkout,
				);
				await command('verify', 'pnpm', ['verify'], checkout);
				if (
					(await moduleReviewRevision(staged)) !== revision ||
					(await moduleReviewRevision(source)) !== revision
				)
					fail('Verification changed reviewed source. Repeat review.');
				await command(
					'review',
					'node',
					[
						'--input-type=module',
						'-e',
						REVIEW_SCRIPT,
						module.targetPath,
						module.id,
						revision,
					],
					checkout,
				);
				await command('pack', 'pnpm', ['release:pack', '--local'], checkout);
				if ((await moduleReviewRevision(staged)) !== revision)
					fail('Packaging changed reviewed source. Repeat review.');
				const manifest = JSON.parse(
					await readFile(join(staged, 'module.json'), 'utf8'),
				);
				if (
					!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)
				)
					fail('Invalid release version.');
				if (manifest.id !== module.id)
					fail('Module identity differs from the reviewed session.');
				const allowed = [
					module.targetPath,
					`reviews/${module.id}.json`,
					`registry/releases/${module.id}/${manifest.version}.json`,
				];
				// Installation may update only the disposable lockfile. Never include it.
				await command('commit', 'git', ['add', '--', ...allowed], checkout);
				const offending = await command(
					'guardrails',
					'git',
					[
						'diff',
						'--cached',
						'--name-only',
						'--',
						'.',
						...allowed.map((path) => `:(exclude)${path}`),
					],
					checkout,
				);
				if (offending) fail('Unexpected staged files.');

				const unrelated = await command(
					'guardrails',
					'git',
					['diff', '--name-only', '--', '.', ':(exclude)pnpm-lock.yaml'],
					checkout,
				);
				if (unrelated)
					fail('Verification changed files outside the contribution.');
				const suffix = createHash('sha256')
					.update(key + revision)
					.digest('hex')
					.slice(0, 24);
				const branch = `official-module/${suffix}`;
				const login = await command(
					'provider',
					'gh',
					['api', 'user', '--jq', '.login'],
					checkout,
				);
				if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login))
					fail('Invalid GitHub identity.');
				const push = await command(
					'provider',
					'gh',
					['api', `repos/${REPOSITORY}`, '--jq', '.permissions.push'],
					checkout,
				);
				const destination =
					push === 'true' ? REPOSITORY : `${login}/official-modules`;
				const head = `${destination.split('/')[0]}:${branch}`;
				const marker = `<!-- flowdular-official:${suffix} -->`;
				const previous = await command(
					'provider',
					'gh',
					[
						'api',
						`repos/${REPOSITORY}/pulls`,
						'--method',
						'GET',
						'-f',
						`head=${head}`,
						'-f',
						'state=open',
						'--jq',
						'[.[] | {url: .html_url, body: (.body // "")}]',
					],
					checkout,
				);

				const prs = JSON.parse(previous) as { url: string; body: string }[];
				let url = prs.find((pr) => pr.body.includes(marker))?.url;
				await command(
					'branch',
					'git',
					['switch', '--quiet', '-c', branch],
					checkout,
				);
				await command(
					'commit',
					'git',
					['commit', '--quiet', '-m', `Add ${module.id} to Official Modules`],
					checkout,
				);
				if (url) {
					await command(
						'fetch',
						'git',
						[
							'fetch',
							'--quiet',
							`https://github.com/${destination}.git`,
							`refs/heads/${branch}`,
						],
						checkout,
					);
					const remoteTree = await command(
						'guardrails',
						'git',
						['rev-parse', 'FETCH_HEAD^{tree}'],
						checkout,
					);
					const reviewedTree = await command(
						'guardrails',
						'git',
						['rev-parse', 'HEAD^{tree}'],
						checkout,
					);
					if (remoteTree !== reviewedTree)
						fail(
							'The existing PR contains different source. Review it before retrying.',
						);
				}
				if (!url) {
					if (push !== 'true') {
						await command(
							'fork',
							'gh',
							['repo', 'fork', REPOSITORY, '--clone=false', '--remote=false'],
							checkout,
						);
						const parent = await command(
							'provider',
							'gh',
							['api', `repos/${destination}`, '--jq', '.parent.full_name'],
							checkout,
						);
						if (parent.toLowerCase() !== REPOSITORY.toLowerCase())
							fail('The destination is not a fork of Official Modules.');
					}
					// A retry after push/PR failure may reuse only byte-identical source.
					const remote = `https://github.com/${destination}.git`;
					const existing = await command(
						'provider',
						'git',
						['ls-remote', '--heads', remote, `refs/heads/${branch}`],
						checkout,
					);
					if (existing) {
						await command(
							'fetch',
							'git',
							['fetch', '--quiet', remote, `refs/heads/${branch}`],
							checkout,
						);
						const before = await command(
							'guardrails',
							'git',
							['rev-parse', 'FETCH_HEAD^{tree}'],
							checkout,
						);
						const after = await command(
							'guardrails',
							'git',
							['rev-parse', 'HEAD^{tree}'],
							checkout,
						);
						if (before !== after)
							fail(
								'The contribution branch has different source. It was preserved; review it before retrying.',
							);
					} else {
						await command(
							'push',
							'git',
							[
								'push',
								'--quiet',
								`--force-with-lease=refs/heads/${branch}:`,
								remote,
								`HEAD:refs/heads/${branch}`,
							],
							checkout,
						);
					}

					const body = join(scratch, 'pr.md');
					await writeFile(
						body,
						`Adds ${module.id}@${manifest.version} from the sandbox.\n\nApproved specification: ${module.targetPath}/spec/module.yaml (SHA256 ${context.session.modules[0]!.specHash}; operator approval at ${context.session.modules[0]!.specApprovedAt}).\nReviewed source revision: ${revision}.\n\nEvidence: all sandbox gates, exact-source auto-review, registry pnpm verify and pnpm release:pack --local passed. See reviews/${module.id}.json. PostgreSQL CI and maintainer review remain required before publication.\n\nNo registry index publication or application activation is performed.\n\n${marker}\n`,
					);
					url = await command(
						'pr',
						'gh',
						[
							'pr',
							'create',
							'--repo',
							REPOSITORY,
							'--base',
							'main',
							'--head',
							push === 'true' ? branch : head,
							'--title',
							`Add ${module.id} to Official Modules`,
							'--body-file',
							body,
						],
						checkout,
					);
				}
				if (
					!/^https:\/\/github\.com\/Flowdular\/official-modules\/pull\/\d+$/i.test(
						url,
					)
				)
					fail('GitHub did not return an Official Modules pull request URL.');
				return {
					moduleId: module.id,
					targetPath: module.targetPath,
					files: copied,
					removed: 0,
					enabled: false,
					gates,
					steps: recorder.steps,
					restartRequired: false,
					branch,
					pullRequestUrl: url,
				};
			} finally {
				active.delete(key);
				if (scratch) await rm(scratch, { recursive: true, force: true });
			}
		},
	};
}
