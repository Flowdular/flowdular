import {
	mkdtemp,
	mkdir,
	writeFile,
	readFile,
	rm,
	symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { runGates } from '../src/server/gates.ts';
import { afterEach, describe, expect, it } from 'vitest';
import {
	inspectAutoReview,
	prepareAutoReview,
	moduleReviewRevision,
	recordAutoReview,
} from '../src/server/auto-review.ts';
import {
	assertGatesPassed,
	runDeliveryGates,
} from '../src/server/delivery/steps.ts';
import {
	sessionPaths,
	basePathOf,
	modulePathOf,
	type SessionModule,
} from '../src/server/sessions.ts';
import type { DeliveryContext } from '../src/server/delivery/types.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});
const report =
	'```auto-review\n' +
	JSON.stringify({
		verdict: 'pass',
		checks: {
			correctness:
				'src/service.ts: accepted input preserves existing behavior.',
			security: 'src/routes.ts: principal tenant and denial tests checked.',
			compatibility: 'package.json: public exports unchanged.',
			lifecycle: 'No owned async resources in changed code.',
			tests:
				'tests/service.test.ts: regression fails with original implementation.',
			ui: 'No rendered UI changes in this module diff.',
		},
		findings: [],
	}) +
	'\n```\nHANDOFF: none - reviewed';
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'auto-review-'));
	roots.push(root);
	const paths = sessionPaths(root, 'review-session', 'sample');
	const module: SessionModule = {
		id: 'sample.core',
		directory: 'sample',
		kind: 'new',
	};
	const directory = modulePathOf(paths, module.directory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, 'package.json'), '{}');
	return { root, paths, module, directory };
}
describe('review evidence', () => {
	it('prepares review from installed SDK skills in a generated consumer and prefers a local override', async () => {
		const { root, paths, module } = await fixture();
		const baseline = basePathOf(paths, module.directory);
		await mkdir(baseline, { recursive: true });
		await writeFile(join(baseline, 'original.ts'), 'original');
		const sdk = join(root, 'node_modules/@flowdular/sdk');
		const bundled = join(sdk, '.ai/skills/auto-review');
		await mkdir(bundled, { recursive: true });
		await writeFile(
			join(sdk, 'package.json'),
			JSON.stringify({
				name: '@flowdular/sdk',
				exports: { './package.json': './package.json' },
			}),
		);
		await writeFile(join(bundled, 'SKILL.md'), 'Bundled review instructions');
		await prepareAutoReview(root, paths, module);
		const target = join(
			paths.workspace,
			'reference/skills/auto-review/SKILL.md',
		);
		expect(await readFile(target, 'utf8')).toBe('Bundled review instructions');
		expect(
			await readFile(
				join(paths.workspace, 'reference/auto-review-base/original.ts'),
				'utf8',
			),
		).toBe('original');
		const local = join(root, '.ai/skills/auto-review');
		await mkdir(local, { recursive: true });
		await writeFile(join(local, 'SKILL.md'), 'Local review instructions');
		await prepareAutoReview(root, paths, module);
		expect(await readFile(target, 'utf8')).toBe('Local review instructions');
	});

	it('requires a report and rejects stale evidence after addition, modification and deletion', async () => {
		const { paths, module, directory } = await fixture();
		expect((await inspectAutoReview(paths, module)).passed).toBe(false);
		const revision = await moduleReviewRevision(directory);
		expect(await recordAutoReview(paths, module, revision, report)).toBe(true);
		expect((await inspectAutoReview(paths, module)).passed).toBe(true);
		await writeFile(join(directory, 'test.ts'), 'changed');
		expect((await inspectAutoReview(paths, module)).passed).toBe(false);
		expect(await recordAutoReview(paths, module, revision, report)).toBe(false);
		await recordAutoReview(
			paths,
			module,
			await moduleReviewRevision(directory),
			report,
		);
		await writeFile(join(directory, 'test.ts'), 'changed again');
		expect((await inspectAutoReview(paths, module)).passed).toBe(false);
		await recordAutoReview(
			paths,
			module,
			await moduleReviewRevision(directory),
			report,
		);
		await rm(join(directory, 'test.ts'));
		expect((await inspectAutoReview(paths, module)).passed).toBe(false);
	});
	it('rejects empty, malformed and unresolved reports', async () => {
		const { paths, module, directory } = await fixture();
		for (const text of [
			'',
			'```auto-review\n{}\n```',
			report.replace('"findings":[]', '"findings":["unfixed bug"]'),
			report.replace('"pass"', '"fail"'),
		]) {
			expect(
				await recordAutoReview(
					paths,
					module,
					await moduleReviewRevision(directory),
					text,
				),
			).toBe(false);
		}
		expect((await inspectAutoReview(paths, module)).passed).toBe(false);
	});
	it('does not transfer approval between modules', async () => {
		const { paths, module, directory } = await fixture();
		await recordAutoReview(
			paths,
			module,
			await moduleReviewRevision(directory),
			report,
		);
		expect(
			(await inspectAutoReview(paths, { ...module, directory: 'other' }))
				.passed,
		).toBe(false);
	});
});
describe('delivery gate requirements', () => {
	it('blocks skipped gates', () => {
		expect(() =>
			assertGatesPassed([
				{
					id: 'tests',
					status: 'skipped',
					command: 'vitest',
					output: 'missing binary',
					durationMs: 0,
				},
			]),
		).toThrow('Eject');
	});
	it('blocks a missing module result', async () => {
		const context = {
			session: { modules: [{ directory: 'one' }, { directory: 'two' }] },
			runGates: async () => [
				{
					id: 'tests',
					module: 'one',
					status: 'passed',
					command: '',
					output: '',
					durationMs: 0,
				},
			],
		} as unknown as DeliveryContext;
		await expect(
			runDeliveryGates(context, ['tests'], () => {}),
		).rejects.toThrow('No result');
	});
});

it('fails the real tests gate when the module has no tests', async () => {
	const { paths, module, directory } = await fixture();
	await writeFile(
		join(directory, 'vitest.config.mts'),
		'export default { test: { passWithNoTests: true } };',
	);
	const executable = join(
		dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
		'vitest.mjs',
	);
	await mkdir(join(directory, 'node_modules', '.bin'), { recursive: true });
	await symlink(executable, join(directory, 'node_modules', '.bin', 'vitest'));
	const session = {
		modules: [module],
	} as unknown as DeliveryContext['session'];
	const results = await runGates({
		workspaceRoot: paths.workspace,
		paths,
		session,
		gates: ['tests'],
	});
	expect(results).toHaveLength(1);
	expect(results[0]!.status).toBe('failed');
	expect(results[0]!.output).toContain('No test files found');
});

it('does not let an empty delivery plan omit required gates', async () => {
	const { module } = await fixture();
	const context = {
		session: { modules: [module] },
		runGates: async () => [],
	} as unknown as DeliveryContext;
	await expect(runDeliveryGates(context, [], () => {})).rejects.toThrow(
		'No result',
	);
});
