import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToString } from 'octane/server';
import { EjectModal } from '../src/client/EjectModal.tsrx';
import {
	registerSandboxTranslations,
	setActiveLocale,
} from '../src/client/i18n.ts';
import {
	createOfficialModulesDeliveryTarget,
	assertOfficialSourcePaths,
} from '../src/server/delivery/official-modules.ts';
import type {
	CommandRunner,
	DeliveryContext,
} from '../src/server/delivery/index.ts';
import {
	createSession,
	sessionPaths,
	updateSession,
} from '../src/server/sessions.ts';
import { hashSpec } from '../src/server/spec.ts';
import { fixtureGates, reviewFixture } from './support/auto-review.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function fixture(
	options: {
		collision?: boolean;
		failVerify?: boolean;
		mutate?: boolean;
		fork?: boolean;
		previous?: boolean;
		openPr?: boolean;
		differentTree?: boolean;
		stray?: boolean;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), 'official-delivery-test-'));
	roots.push(root);
	await writeFile(join(root, 'flowdular.json'), '{"schemaVersion":1}');
	const created = await createSession({
		workspaceRoot: root,
		kind: 'new-module',
		moduleId: 'inventory.core',
		title: 'Inventory',
		brief: 'Track stock',
		blueprint: 'new-module@1.0.0',
		role: 'backend-engineer',
		driver: 'codex',
		install: false,
	});
	const paths = sessionPaths(root, created.id, created.moduleSuffix);
	await mkdir(join(paths.modulePath, 'spec'), { recursive: true });
	await mkdir(join(paths.modulePath, 'src'), { recursive: true });
	const spec = 'id: inventory.core\nstatus: approved\nspecVersion: 0.1.0\n';
	await writeFile(join(paths.modulePath, 'spec/module.yaml'), spec);
	await writeFile(
		join(paths.modulePath, 'module.json'),
		'{"id":"inventory.core","version":"0.1.0"}',
	);
	await writeFile(
		join(paths.modulePath, 'src/index.ts'),
		'export const inventory = {};\n',
	);
	const session = await updateSession(root, created.id, {
		modules: [
			{
				...created.modules[0]!,
				specHash: hashSpec(spec),
				specApprovedAt: Date.now(),
			},
		],
	});
	await reviewFixture(root, session);
	const calls: {
		command: string;
		args: readonly string[];
		cwd: string;
		env?: NodeJS.ProcessEnv | undefined;
	}[] = [];
	let body = '';
	const commands: CommandRunner = async (command, args, cwd, config) => {
		calls.push({ command, args, cwd, env: config?.env });
		if (command === 'git' && args[0] === 'clone') {
			const checkout = args.at(-1)!;
			await mkdir(join(checkout, 'modules'), { recursive: true });
			if (options.collision) await mkdir(join(checkout, 'modules/inventory'));
		}
		if (command === 'pnpm' && args[0] === 'verify') {
			if (options.failVerify) return { code: 1, output: 'regression failed' };
			if (options.mutate)
				await writeFile(join(cwd, 'modules/inventory/src/index.ts'), 'changed');
		}
		let output = '';
		if (
			command === 'git' &&
			args[0] === 'diff' &&
			args.includes('--cached') &&
			options.stray
		)
			output = '.github/workflows/unreviewed.yml';
		if (command === 'gh' && args[0] === 'api') {
			output =
				args[1] === 'user'
					? 'contributor'
					: args.at(-1) === '.permissions.push'
						? String(!options.fork)
						: 'Flowdular/official-modules';
		}
		if (command === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls'))
			output = options.openPr
				? JSON.stringify([
						{
							url: 'https://github.com/Flowdular/official-modules/pull/42',
							body: `<!-- flowdular-official:${args
								.find((arg) => arg.startsWith('head='))!
								.split('/')
								.at(-1)} -->`,
						},
					])
				: '[]';
		if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
			body = await readFile(args.at(-1)!, 'utf8');
			output = 'https://github.com/Flowdular/official-modules/pull/42';
		}
		if (command === 'git' && args[0] === 'ls-remote' && options.previous)
			output = 'commit refs/heads/branch';
		if (command === 'git' && args[0] === 'rev-parse')
			output =
				options.differentTree && args[1] === 'FETCH_HEAD^{tree}'
					? 'changed-tree'
					: 'same-tree';
		return { code: 0, output };
	};
	const context: DeliveryContext = {
		workspaceRoot: root,
		session,
		capabilities: ['sandbox.modules.eject'],
		platformUrl: 'http://localhost:3000',
		commands,
		runGates: async (ids) => fixtureGates(session, ids),
		gitProviderToken: async () => 'test-provider-secret',
	};
	return { root, paths, context, calls, body: () => body };
}
const target = createOfficialModulesDeliveryTarget();
describe('official module contribution', () => {
	it('blocks stale review and missing permission before external commands', async () => {
		const fx = await fixture();
		await expect(
			target.plan({ ...fx.context, capabilities: [] }),
		).rejects.toThrow(/scope|grant/i);
		await writeFile(join(fx.paths.modulePath, 'src/index.ts'), 'changed');
		expect((await target.available(fx.context)).available).toBe(false);
		expect(fx.calls).toHaveLength(0);
	});
	it('blocks failed or missing gates before cloning or pushing', async () => {
		const fx = await fixture();
		const plan = await target.plan(fx.context);
		await expect(
			target.apply({ ...fx.context, runGates: async () => [] }, plan, () => {}),
		).rejects.toThrow(/No result/);
		await expect(
			target.apply(
				{
					...fx.context,
					runGates: async (ids) =>
						fixtureGates(fx.context.session, ids, 'failed'),
				},
				plan,
				() => {},
			),
		).rejects.toThrow();
		expect(fx.calls).toHaveLength(0);
	});
	it.each([
		{ collision: true },
		{ failVerify: true },
		{ mutate: true },
		{ stray: true },
	])('does not publish after %j', async (options) => {
		const fx = await fixture(options);
		const plan = await target.plan(fx.context);
		await expect(target.apply(fx.context, plan, () => {})).rejects.toThrow();
		expect(
			fx.calls.some(
				(call) =>
					call.args[0] === 'push' ||
					call.args[0] === 'fork' ||
					call.args[1] === 'create',
			),
		).toBe(false);
	});
	it.each([false, true])(
		'opens the fixed upstream PR after checks, fork=%s',
		async (fork) => {
			const fx = await fixture({ fork });
			const plan = await target.plan(fx.context);
			const result = await target.apply(fx.context, plan, () => {});
			expect(result.pullRequestUrl).toBe(
				'https://github.com/Flowdular/official-modules/pull/42',
			);
			expect(result.enabled).toBe(false);
			const verify = fx.calls.findIndex(
				(call) => call.command === 'pnpm' && call.args[0] === 'verify',
			);
			const push = fx.calls.findIndex(
				(call) => call.command === 'git' && call.args[0] === 'push',
			);
			expect(push).toBeGreaterThan(verify);
			expect(fx.calls[push]!.args.join(' ')).toContain(
				fork
					? 'contributor/official-modules.git'
					: 'Flowdular/official-modules.git',
			);
			expect(fx.body()).toContain(
				'PostgreSQL CI and maintainer review remain required',
			);
			expect(
				fx.calls
					.filter((call) => call.command === 'pnpm')
					.every(
						(call) =>
							!JSON.stringify(call.env).includes('test-provider-secret'),
					),
			).toBe(true);
			expect(fx.calls.some((call) => call.args.includes('enable'))).toBe(false);
			await expect(
				readFile(join(fx.root, 'modules/inventory/module.json')),
			).rejects.toThrow();
			await expect(
				readFile(
					join(
						fx.calls.find((call) => call.args[0] === 'clone')!.args.at(-1)!,
						'modules/inventory/module.json',
					),
				),
			).rejects.toThrow();
		},
	);
	it('reuses an identical pushed branch after an interrupted PR request', async () => {
		const fx = await fixture({ previous: true });
		await target.apply(fx.context, await target.plan(fx.context), () => {});
		expect(fx.calls.some((call) => call.args[0] === 'push')).toBe(false);
		expect(
			fx.calls.some(
				(call) => call.command === 'gh' && call.args[1] === 'create',
			),
		).toBe(true);
	});
	it('reuses an open PR only when its branch still has the reviewed tree', async () => {
		const fx = await fixture({ openPr: true });
		await target.apply(fx.context, await target.plan(fx.context), () => {});
		expect(
			fx.calls.some(
				(call) => call.args[0] === 'push' || call.args[1] === 'create',
			),
		).toBe(false);
	});
	it.each([
		{ openPr: true, differentTree: true },
		{ previous: true, differentTree: true },
	])('preserves a branch changed outside this review: %j', async (options) => {
		const fx = await fixture(options);
		await expect(
			target.apply(fx.context, await target.plan(fx.context), () => {}),
		).rejects.toThrow(/different source/);
		expect(
			fx.calls.some(
				(call) => call.args[0] === 'push' || call.args[1] === 'create',
			),
		).toBe(false);
	});
	it('rejects credentials, traversal and generated paths', () => {
		for (const path of [
			'.env',
			'src/.env',
			'src/../../secret',
			'src/node_modules/key',
			'README.md/secret',
			'dist/app.js',
		])
			expect(() => assertOfficialSourcePaths([path])).toThrow();
		expect(() =>
			assertOfficialSourcePaths([
				'src/index.ts',
				'spec/module.yaml',
				'tests/module.test.ts',
			]),
		).not.toThrow();
	});
	it('renders the reviewed contribution destination and publication boundary in Polish', async () => {
		const fx = await fixture();
		const plan = await target.plan(fx.context);
		registerSandboxTranslations();
		setActiveLocale('pl');
		const html = renderToString(EjectModal, {
			plan: {
				...plan,
				availableTargets: [
					{ id: 'official-modules', available: true, reason: null },
				],
			},
			steps: [],
			summary: null,
			error: '',
			running: false,
			build: false,
			onBuild: () => {},
			onTarget: () => {},
			onConfirm: () => {},
			onClose: () => {},
		}).html;
		expect(html).toContain('Flowdular/official-modules');
		expect(html).toContain('Maintainerzy zdecydują');
	});
});
