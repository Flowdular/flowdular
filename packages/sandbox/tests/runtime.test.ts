import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_ROLES } from '@coreloom/coding-agent';
import {
	assertBrief,
	classifyByRules,
	parsePlan,
	planHandoff,
	routeRole,
} from '../src/server/planning.ts';
import {
	DEFAULT_CONFIGURATION,
	assertPlatformUrl,
	checkDeclaredDependencies,
	createLocalDeliveryTarget,
	diffTrees,
	isGateId,
	loadSandboxConfiguration,
	moduleSuffixOf,
	openSecret,
	resolveDeliveryTarget,
	safeConfiguration,
	saveSandboxConfiguration,
	sealSecret,
	type CommandRunner,
	type DeliveryContext,
} from '../src/server/index.ts';
import {
	appendChatEntry,
	approveSpecification,
	archiveSession,
	createSession,
	deleteSession,
	listSessions,
	readChat,
	readSession,
	restoreSession,
	sessionPaths,
	updateSession,
	type SandboxSession,
} from '../src/server/sessions.ts';
import { collectDiffs } from '../src/server/turns.ts';
import { hashSpec } from '../src/server/spec.ts';

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'coreloom-sandbox-'));
	await writeFile(
		join(root, 'coreloom.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
		'utf8',
	);
	await writeFile(join(root, 'tsconfig.base.json'), '{}', 'utf8');
	await writeFile(join(root, '.prettierrc.json'), '{}', 'utf8');
	return root;
}

const PASSED_GATE = {
	id: 'typecheck' as const,
	status: 'passed' as const,
	durationMs: 1,
	command: 'tsrx-tsc',
	output: '',
};

describe('sandbox configuration', () => {
	it('keeps secrets encrypted at rest and out of the browser payload', async () => {
		const root = await workspace();
		const sealed = await sealSecret(root, 'clat_secret-value');
		expect(JSON.stringify(sealed)).not.toContain('clat_secret-value');
		expect(await openSecret(root, sealed)).toBe('clat_secret-value');

		const stored = await saveSandboxConfiguration(root, {
			...DEFAULT_CONFIGURATION,
			platformToken: sealed,
			gitProviderToken: await sealSecret(root, 'github_pat_secret'),
		});
		const safe = safeConfiguration(stored);
		expect(JSON.stringify(safe)).not.toContain('clat_secret-value');
		expect(JSON.stringify(safe)).not.toContain('github_pat_secret');
		expect(safe.platformTokenFingerprint).toHaveLength(8);
		expect(safe.github.tokenFingerprint).toHaveLength(8);
		expect((await loadSandboxConfiguration(root)).platformToken).toEqual(
			sealed,
		);
	});

	it('refuses symlinked local secret and configuration files', async () => {
		const root = await workspace();
		const outside = await mkdtemp(join(tmpdir(), 'coreloom-sandbox-outside-'));
		const sandboxDirectory = join(root, '.coreloom', 'sandbox');
		await mkdir(sandboxDirectory, { recursive: true });
		const outsideKey = join(outside, 'secret.key');
		await writeFile(outsideKey, Buffer.alloc(32, 7).toString('base64'), 'utf8');
		await symlink(outsideKey, join(sandboxDirectory, 'secret.key'));

		await expect(sealSecret(root, 'must-stay-local')).rejects.toThrow(
			/symbolic link/,
		);

		await rm(join(sandboxDirectory, 'secret.key'));
		const outsideConfig = join(outside, 'config.json');
		await writeFile(outsideConfig, 'outside-file', 'utf8');
		await symlink(outsideConfig, join(sandboxDirectory, 'config.json'));
		await expect(
			saveSandboxConfiguration(root, DEFAULT_CONFIGURATION),
		).rejects.toThrow(/symbolic link/);
		expect(await readFile(outsideConfig, 'utf8')).toBe('outside-file');
	});

	it('falls back to the loopback default when nothing is configured', async () => {
		const configuration = await loadSandboxConfiguration(await workspace());
		expect(configuration.mode).toBe('loopback');
		expect(configuration.previewData).toBe('fixtures');
		expect(configuration.github.enabled).toBe(true);
		expect(configuration.github.overridesProject).toBe(false);
	});

	it('does not mistake materialized GitHub defaults for a local override', async () => {
		const root = await workspace();
		await mkdir(join(root, '.coreloom/sandbox'), { recursive: true });
		await writeFile(
			join(root, '.coreloom/sandbox/config.json'),
			JSON.stringify({
				...DEFAULT_CONFIGURATION,
				github: {
					enabled: true,
					remote: 'origin',
					repository: null,
					baseBranch: 'main',
					branchPrefix: 'sandbox',
					mode: 'auto',
					forkOwner: null,
					reviewers: [],
				},
			}),
			'utf8',
		);
		expect((await loadSandboxConfiguration(root)).github.overridesProject).toBe(
			false,
		);
	});

	it('preserves a local GitHub override written before the marker existed', async () => {
		const root = await workspace();
		await mkdir(join(root, '.coreloom/sandbox'), { recursive: true });
		await writeFile(
			join(root, '.coreloom/sandbox/config.json'),
			JSON.stringify({
				...DEFAULT_CONFIGURATION,
				github: {
					enabled: true,
					remote: 'upstream',
					repository: 'example/coreloom',
					baseBranch: 'develop',
					branchPrefix: 'changes',
					mode: 'direct',
					forkOwner: null,
					reviewers: [],
				},
			}),
			'utf8',
		);
		expect((await loadSandboxConfiguration(root)).github.overridesProject).toBe(
			true,
		);
	});

	it('uses the CL sandbox mode contract and ignores the removed legacy name', async () => {
		const current = process.env.CL_SANDBOX_MODE;
		const legacy = process.env.CORELOOM_SANDBOX_MODE;
		process.env.CL_SANDBOX_MODE = 'self-hosted';
		process.env.CORELOOM_SANDBOX_MODE = 'loopback';
		try {
			expect((await loadSandboxConfiguration(await workspace())).mode).toBe(
				'self-hosted',
			);
		} finally {
			if (current === undefined) delete process.env.CL_SANDBOX_MODE;
			else process.env.CL_SANDBOX_MODE = current;
			if (legacy === undefined) delete process.env.CORELOOM_SANDBOX_MODE;
			else process.env.CORELOOM_SANDBOX_MODE = legacy;
		}
	});

	it('rejects a platform address that is not an http origin', () => {
		expect(assertPlatformUrl('https://erp.example.test/api/')).toBe(
			'https://erp.example.test',
		);
		expect(assertPlatformUrl('http://127.0.0.1:4310')).toBe(
			'http://127.0.0.1:4310',
		);
		expect(() => assertPlatformUrl('http://erp.example.test')).toThrow(/HTTPS/);
		expect(() => assertPlatformUrl('ftp://erp.example.test')).toThrow(
			/http or https/,
		);
		expect(() => assertPlatformUrl('not-a-url')).toThrow(/absolute URL/);
	});
});

describe('sandbox sessions', () => {
	it('derives the module directory from the module id', () => {
		expect(moduleSuffixOf('sales.orders')).toBe('sales-orders');
		expect(moduleSuffixOf('profile.core')).toBe('profile');
	});

	it('prepares an isolated pnpm workspace for a new module', async () => {
		const root = await workspace();
		const session = await createSession({
			workspaceRoot: root,
			kind: 'new-module',
			moduleId: 'profile.core',
			title: 'User profile',
			brief: 'A screen where a user changes their display name.',
			blueprint: 'new-module@1.0.0',
			role: 'business-manager',
			driver: 'codex',
			install: false,
		});
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		expect(session.moduleSuffix).toBe('profile');
		expect(session.modules).toEqual([
			{ id: 'profile.core', directory: 'profile', kind: 'new' },
		]);
		expect(
			JSON.parse(
				await readFile(join(paths.workspace, 'coreloom.json'), 'utf8'),
			),
		).toMatchObject({ modules: { enabled: ['profile.core'] } });
		expect(
			await readFile(join(paths.workspace, 'tsconfig.base.json'), 'utf8'),
		).toBe('{}');
		expect(
			await readFile(join(paths.workspace, 'pnpm-workspace.yaml'), 'utf8'),
		).toContain('  - modules/*');
		expect(
			JSON.parse(await readFile(join(paths.workspace, 'package.json'), 'utf8')),
		).toMatchObject({ name: 'coreloom-session', private: true });
		expect((await listSessions(root)).map((entry) => entry.id)).toEqual([
			session.id,
		]);
	});

	it('links every host package the session does not draft', async () => {
		const root = await workspace();
		await mkdir(join(root, 'packages', 'server'), { recursive: true });
		await writeFile(
			join(root, 'packages', 'server', 'package.json'),
			JSON.stringify({ name: '@coreloom/server' }),
			'utf8',
		);
		await mkdir(join(root, 'modules', 'auth'), { recursive: true });
		await writeFile(
			join(root, 'modules', 'auth', 'package.json'),
			JSON.stringify({ name: '@coreloom/module-auth' }),
			'utf8',
		);
		await writeFile(
			join(root, 'modules', 'auth', 'module.json'),
			'{"id":"auth.core"}',
		);
		const session = await createSession({
			workspaceRoot: root,
			kind: 'edit-module',
			moduleId: 'auth.core',
			title: 'Roles',
			brief: 'Change auth.core roles.',
			blueprint: 'edit-module@1.0.0',
			role: 'backend-engineer',
			driver: 'codex',
			sourceModule: 'auth',
			install: false,
		});
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		const manifest = await readFile(
			join(paths.workspace, 'pnpm-workspace.yaml'),
			'utf8',
		);
		expect(manifest).toContain(
			`'@coreloom/server': 'link:${join(root, 'packages', 'server')}'`,
		);
		expect(manifest).not.toContain('@coreloom/module-auth');
	});

	it('copies an existing module and keeps a pristine base for the diff', async () => {
		const root = await workspace();
		const source = join(root, 'modules', 'auth');
		await mkdir(join(source, 'src'), { recursive: true });
		await writeFile(join(source, 'module.json'), '{"id":"auth.core"}', 'utf8');
		await writeFile(join(source, 'src', 'index.ts'), 'export const a = 1;\n');

		const session = await createSession({
			workspaceRoot: root,
			kind: 'edit-module',
			moduleId: 'auth.core',
			title: 'Custom roles',
			brief: 'Let an owner define workspace roles.',
			blueprint: 'edit-module@1.0.0',
			role: 'backend-engineer',
			driver: 'codex',
			sourceModule: 'auth',
			install: false,
		});
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		expect(await readFile(join(paths.modulePath, 'src/index.ts'), 'utf8')).toBe(
			'export const a = 1;\n',
		);

		await writeFile(
			join(paths.modulePath, 'src', 'index.ts'),
			'export const a = 2;\n',
		);
		await writeFile(join(paths.modulePath, 'src', 'roles.ts'), 'export {};\n');
		const diffs = await diffTrees(
			join(paths.base, 'modules', session.moduleSuffix),
			paths.modulePath,
		);
		expect(diffs.map((diff) => [diff.path, diff.change])).toEqual([
			['src/index.ts', 'modified'],
			['src/roles.ts', 'created'],
		]);
		expect(diffs[0]?.hunks[0]?.lines.some((line) => line.type === 'add')).toBe(
			true,
		);
	});

	it('materializes every module of a multi-module session and diffs each', async () => {
		const root = await workspace();
		for (const [directory, id] of [
			['parties', 'parties.core'],
			['catalog', 'catalog.core'],
		]) {
			await mkdir(join(root, 'modules', directory!, 'src'), {
				recursive: true,
			});
			await writeFile(
				join(root, 'modules', directory!, 'module.json'),
				JSON.stringify({ id }),
			);
			await writeFile(
				join(root, 'modules', directory!, 'src', 'index.ts'),
				`export const ${directory} = 1;\n`,
			);
		}
		const session = await createSession({
			workspaceRoot: root,
			kind: 'edit-module',
			moduleId: 'parties.core',
			modules: [
				{ id: 'parties.core', directory: 'parties', kind: 'edit' },
				{ id: 'catalog.core', directory: 'catalog', kind: 'edit' },
			],
			title: 'Field across modules',
			brief: 'Add a field in parties.core and show it in catalog.core.',
			blueprint: 'edit-module@1.0.0',
			role: 'backend-engineer',
			driver: 'codex',
			install: false,
		});
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await writeFile(
			join(paths.workspace, 'modules', 'catalog', 'src', 'index.ts'),
			'export const catalog = 2;\n',
		);
		const diffs = await collectDiffs(root, session);
		expect(diffs.map((diff) => [diff.module, diff.path])).toEqual([
			['catalog', 'src/index.ts'],
		]);
		const enabled = JSON.parse(
			await readFile(join(paths.workspace, 'coreloom.json'), 'utf8'),
		) as { modules: { enabled: string[] } };
		expect(enabled.modules.enabled).toEqual(['catalog.core', 'parties.core']);
	});

	it('rejects a module id that is not dot separated', async () => {
		const root = await workspace();
		await expect(
			createSession({
				workspaceRoot: root,
				kind: 'new-module',
				moduleId: 'profile',
				title: 'User profile',
				brief: 'A screen where a user changes their display name.',
				blueprint: 'new-module@1.0.0',
				role: 'business-manager',
				driver: 'codex',
				install: false,
			}),
		).rejects.toThrow(/dot-separated/);
	});

	it('appends chat entries in order and reads them back after a cursor', async () => {
		const root = await workspace();
		const session = await createSession({
			workspaceRoot: root,
			kind: 'new-module',
			moduleId: 'profile.core',
			title: 'User profile',
			brief: 'A screen where a user changes their display name.',
			blueprint: 'new-module@1.0.0',
			role: 'business-manager',
			driver: 'codex',
			install: false,
		});
		await appendChatEntry(root, session, {
			kind: 'user',
			role: 'business-manager',
			text: 'first',
		});
		await appendChatEntry(root, session, {
			kind: 'agent',
			role: 'business-manager',
			text: 'second',
		});
		expect((await readChat(root, session)).map((entry) => entry.text)).toEqual([
			'first',
			'second',
		]);
		expect(
			(await readChat(root, session, 1)).map((entry) => entry.text),
		).toEqual(['second']);
		expect((await readSession(root, session.id)).moduleId).toBe('profile.core');
	});
});

describe('session identifiers', () => {
	async function sessionRoot() {
		const root = await workspace();
		const session = await createSession({
			workspaceRoot: root,
			kind: 'new-module',
			moduleId: 'profile.core',
			title: 'User profile',
			brief: 'A screen where a user changes their display name.',
			blueprint: 'new-module@1.0.0',
			role: 'business-manager',
			driver: 'codex',
			install: false,
		});
		return { root, session };
	}

	it('refuses to read or delete anything that is not a session id', async () => {
		const { root } = await sessionRoot();
		await writeFile(join(root, 'keep.txt'), 'keep', 'utf8');
		for (const hostile of ['../../..', '..', 'session', '/etc', 'a/b']) {
			await expect(readSession(root, hostile)).rejects.toThrow(
				/not a sandbox session identifier/,
			);
			await expect(deleteSession(root, hostile)).rejects.toThrow(
				/not a sandbox session identifier/,
			);
		}
		expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('keep');
		await expect(stat(join(root, 'coreloom.json'))).resolves.toBeDefined();
	});

	it('refuses to delete through a symlink planted in the sessions directory', async () => {
		const { root, session } = await sessionRoot();
		const outside = await mkdtemp(join(tmpdir(), 'coreloom-outside-'));
		await writeFile(join(outside, 'victim.txt'), 'victim', 'utf8');
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		const planted = '00000000-0000-4000-8000-000000000001';
		await symlink(outside, join(paths.root, '..', planted));
		await writeFile(
			join(outside, 'session.json'),
			JSON.stringify({ ...session, id: planted }),
			'utf8',
		);
		await expect(deleteSession(root, planted)).rejects.toThrow(
			/not inside the sandbox sessions directory/,
		);
		expect(await readFile(join(outside, 'victim.txt'), 'utf8')).toBe('victim');
	});

	it('archives, restores, and deletes while keeping the transcript', async () => {
		const { root, session } = await sessionRoot();
		await appendChatEntry(root, session, {
			kind: 'user',
			role: 'business-manager',
			text: 'hello',
		});
		const archived = await archiveSession(root, session.id);
		expect(archived.archivedAt).not.toBeNull();
		expect((await listSessions(root)).map((entry) => entry.archivedAt)).toEqual(
			[archived.archivedAt],
		);
		const restored = await restoreSession(root, session.id);
		expect(restored.archivedAt).toBeNull();

		await deleteSession(root, session.id);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await expect(stat(paths.workspace)).rejects.toThrow();
		expect((await readSession(root, session.id)).state).toBe('deleted');
		expect((await readChat(root, session)).map((entry) => entry.text)).toEqual([
			'hello',
		]);
		expect(await listSessions(root)).toEqual([]);

		await deleteSession(root, session.id, { keepTranscript: false });
		await expect(stat(paths.root)).rejects.toThrow();
	});
});

describe('sandbox gates', () => {
	it('accepts only the fixed gate identifiers', () => {
		expect(isGateId('typecheck')).toBe(true);
		expect(isGateId('rm -rf /')).toBe(false);
	});
});

describe('delivery', () => {
	async function sessionWithModule(kind: 'new-module' | 'edit-module') {
		const root = await workspace();
		if (kind === 'edit-module') {
			const source = join(root, 'modules', 'profile');
			await mkdir(join(source, 'src'), { recursive: true });
			await writeFile(join(source, 'module.json'), '{"id":"profile.core"}\n');
			await writeFile(join(source, 'src', 'index.ts'), 'export const a = 1;\n');
			await writeFile(join(source, 'src', 'old.ts'), 'export const old = 1;\n');
		}
		const session = await createSession({
			workspaceRoot: root,
			kind,
			moduleId: 'profile.core',
			title: 'User profile',
			brief: 'A screen where a user changes their display name.',
			blueprint: `${kind}@1.0.0`,
			role: 'backend-engineer',
			driver: 'codex',
			...(kind === 'edit-module' ? { sourceModule: 'profile' } : {}),
			install: false,
		});
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await mkdir(join(paths.modulePath, 'src'), { recursive: true });
		await writeFile(
			join(paths.modulePath, 'module.json'),
			'{"id":"profile.core"}\n',
			'utf8',
		);
		await writeFile(
			join(paths.modulePath, 'src', 'index.ts'),
			'export const moduleDefinition = {};\n',
			'utf8',
		);
		if (kind === 'edit-module') {
			await rm(join(paths.modulePath, 'src', 'old.ts'));
		}
		const spec = [
			'id: profile.core',
			'name: Profile',
			'description: User profile',
			'specVersion: 0.1.0',
			'status: approved',
			'acceptanceScenarios:',
			'  - id: PROFILE-READ',
			'    given: a signed-in user',
			'    when: they open their profile',
			'    then: their profile is shown',
			'',
		].join('\n');
		await mkdir(join(paths.modulePath, 'spec'), { recursive: true });
		await writeFile(
			join(paths.modulePath, 'spec', 'module.yaml'),
			spec,
			'utf8',
		);
		const approved = await updateSession(root, session.id, {
			modules: session.modules.map((module) => ({
				...module,
				specHash: hashSpec(spec),
				specApprovedAt: Date.now(),
			})),
		});
		return { root, session: approved };
	}

	const recording = (failing: string | null = null) => {
		const calls: string[] = [];
		const commands: CommandRunner = async (_command, args) => {
			const step = args.includes('install')
				? 'install'
				: args.includes('enable')
					? 'enable'
					: args.includes('sync-scopes')
						? 'scopes'
						: args.includes('typecheck')
							? 'verify'
							: 'build';
			calls.push(step);
			return step === failing
				? { code: 1, output: `${step} exploded` }
				: { code: 0, output: '' };
		};
		return { calls, commands };
	};

	const contextFor = (
		root: string,
		session: SandboxSession,
		commands: CommandRunner,
		gateStatus: 'passed' | 'failed' = 'passed',
	): DeliveryContext => ({
		workspaceRoot: root,
		session,
		capabilities: ['sandbox.access.use', 'sandbox.modules.eject'],
		platformUrl: 'http://127.0.0.1:4310',
		runGates: async (gates) =>
			gates.map((id) => ({
				...PASSED_GATE,
				id: id as typeof PASSED_GATE.id,
				status: gateStatus,
				output: gateStatus === 'failed' ? `${id} failed` : '',
			})),
		commands,
	});

	it('plans the exact files, removals, and gates before writing anything', async () => {
		const { root, session } = await sessionWithModule('edit-module');
		const plan = await createLocalDeliveryTarget().plan(
			contextFor(root, session, recording().commands),
		);
		expect(plan.files).toEqual([
			'module.json',
			'spec/module.yaml',
			'src/index.ts',
		]);
		expect(plan.overwrites).toEqual(['src/index.ts']);
		expect(plan.removes).toEqual(['src/old.ts']);
		expect(plan.targetPath).toBe('modules/profile');
		expect(plan.enable).toBe(false);
		expect(plan.modules).toHaveLength(1);
		expect(plan.changedFiles).toBe(4);
		expect(plan.platformLocal).toBe(true);
		expect(plan.restartRequired).toBe(true);
		expect(plan.gates).toContain('tests');
		expect(plan.applied).toBe(false);
		expect(
			await readFile(join(root, 'modules/profile/src/old.ts'), 'utf8'),
		).toBe('export const old = 1;\n');
	});

	it('refuses without the eject capability', async () => {
		const { root, session } = await sessionWithModule('new-module');
		await expect(
			createLocalDeliveryTarget().plan({
				...contextFor(root, session, recording().commands),
				capabilities: ['sandbox.access.use'],
			}),
		).rejects.toThrow(/sandbox.modules.eject/);
	});

	it('refuses to apply while a gate is failing', async () => {
		const { root, session } = await sessionWithModule('new-module');
		const target = createLocalDeliveryTarget();
		const { calls, commands } = recording();
		const context = contextFor(root, session, commands, 'failed');
		const plan = await target.plan(context);
		await expect(target.apply(context, plan, () => undefined)).rejects.toThrow(
			/blocked by failing gates/,
		);
		expect(calls).toEqual([]);
		await expect(stat(join(root, 'modules/profile'))).rejects.toThrow();
	});

	it('copies, removes, enables, and verifies in order when everything passes', async () => {
		const { root, session } = await sessionWithModule('edit-module');
		const target = createLocalDeliveryTarget();
		const { calls, commands } = recording();
		const context = contextFor(root, session, commands);
		const plan = await target.plan(context);
		const events: string[] = [];
		const outcome = await target.apply(context, plan, (event) =>
			events.push(event),
		);
		expect(outcome.files).toBe(3);
		expect(outcome.removed).toBe(1);
		expect(outcome.enabled).toBe(false);
		expect(calls).toEqual(['install', 'scopes', 'verify']);
		expect(
			await readFile(join(root, 'modules/profile/src/index.ts'), 'utf8'),
		).toBe('export const moduleDefinition = {};\n');
		await expect(
			stat(join(root, 'modules/profile/src/old.ts')),
		).rejects.toThrow();
		expect(events).toContain('remove.completed');
		expect(events.at(-1)).toBe('restart.required');
	});

	it('enables a new module and stops at the first failing step', async () => {
		const { root, session } = await sessionWithModule('new-module');
		const target = createLocalDeliveryTarget();
		const { calls, commands } = recording('enable');
		const context = contextFor(root, session, commands);
		const plan = await target.plan(context);
		expect(plan.enable).toBe(true);
		const events: string[] = [];
		await expect(
			target.apply(context, plan, (event) => events.push(event)),
		).rejects.toThrow(/enable step failed/);
		expect(calls).toEqual(['install', 'enable']);
		expect(events).not.toContain('scopes.started');
		expect(events).not.toContain('restart.required');
	});

	it('resolves only the workspace target for now', () => {
		expect(resolveDeliveryTarget('workspace').id).toBe('local');
		expect(() => resolveDeliveryTarget('repository')).toThrow(
			/not implemented/,
		);
	});
});

describe('work planning', () => {
	const modules = [
		{ id: 'auth.core', directory: 'auth', name: 'auth' },
		{ id: 'users.core', directory: 'users', name: 'users' },
		{ id: 'catalog.core', directory: 'catalog', name: 'catalog' },
	];

	it('routes a request that names an existing module to a change session', () => {
		const plan = classifyByRules(
			'Add custom roles to auth.core so an owner can define workspace roles.',
			modules,
		);
		expect(plan).toMatchObject({
			kind: 'edit-module',
			moduleId: 'auth.core',
			sourceModule: 'auth',
			classifiedBy: 'rules',
		});
		expect(plan.modules).toEqual([
			{ id: 'auth.core', directory: 'auth', kind: 'edit' },
		]);
	});

	it('never mistakes an English word for a module directory', () => {
		const plan = classifyByRules('Let users book meeting rooms.', modules);
		expect(plan.kind).toBe('new-module');
		expect(plan.moduleId).not.toBe('users.core');
		expect(plan.moduleId).toBe('book.core');
	});

	it('accepts an explicit module phrase and several dotted ids', () => {
		expect(
			classifyByRules('Show the party field in module catalog.', modules),
		).toMatchObject({ kind: 'edit-module', moduleId: 'catalog.core' });
		const plan = classifyByRules(
			'Add a field in auth.core and show it in catalog.core.',
			modules,
		);
		expect(plan.modules.map((module) => module.id)).toEqual([
			'auth.core',
			'catalog.core',
		]);
	});

	it('names every module a two-module request touches, primary first', () => {
		const plan = classifyByRules(
			'Add a VAT field to catalog.core and show it on the auth.core screen.',
			modules,
		);
		expect(plan.kind).toBe('edit-module');
		expect(plan.moduleId).toBe('catalog.core');
		expect(plan.modules.map((module) => [module.id, module.kind])).toEqual([
			['catalog.core', 'edit'],
			['auth.core', 'edit'],
		]);
		expect(plan.rationale).toContain('existing modules');
	});

	it('adds an invented id as a new module beside the existing one', () => {
		const plan = classifyByRules(
			'Move the price rules out of catalog.core into pricing.core.',
			modules,
		);
		expect(plan.modules.map((module) => [module.id, module.kind])).toEqual([
			['catalog.core', 'edit'],
			['pricing.core', 'new'],
		]);
		expect(plan.kind).toBe('edit-module');
		expect(plan.rationale).toContain('does not exist yet');
	});

	it('never reads a file name as a module id', () => {
		const plan = classifyByRules(
			'Update package.json and tsconfig.json in auth.core.',
			modules,
		);
		expect(plan.modules.map((module) => module.id)).toEqual(['auth.core']);
	});

	it('treats an unknown capability as a new module', () => {
		const plan = classifyByRules(
			'Teams should log time against a project.',
			modules,
		);
		expect(plan.kind).toBe('new-module');
		expect(plan.moduleId).toMatch(/^[a-z][a-z0-9-]*\.core$/);
		expect(plan.firstRole).toBe('business-manager');
	});

	it('never lets the planner turn a known module into a new one', () => {
		const fallback = classifyByRules('Something about invoices.', modules);
		const plan = parsePlan(
			'Sure. {"kind":"new-module","moduleId":"catalog.core","modules":["catalog.core","auth.core"],"title":"Catalog prices","firstRole":"backend-engineer","rationale":"Prices live in the catalog."}',
			modules,
			DEFAULT_AGENT_ROLES,
			fallback,
		);
		expect(plan.kind).toBe('edit-module');
		expect(plan.sourceModule).toBe('catalog');
		expect(plan.modules.map((module) => [module.id, module.kind])).toEqual([
			['catalog.core', 'edit'],
			['auth.core', 'edit'],
		]);
		expect(plan.title).toBe('Catalog prices');
		expect(plan.classifiedBy).toBe('agent');
	});

	it('keeps a module the brief named even when the planner forgets it', () => {
		const fallback = classifyByRules(
			'Add a field in auth.core and show it in catalog.core.',
			modules,
		);
		const plan = parsePlan(
			'{"kind":"edit-module","moduleId":"auth.core","modules":["auth.core"],"title":"Party VAT","firstRole":"backend-engineer","rationale":"Roles live in auth."}',
			modules,
			DEFAULT_AGENT_ROLES,
			fallback,
		);
		expect(plan.modules.map((module) => module.id)).toEqual([
			'auth.core',
			'catalog.core',
		]);
		expect(plan.classifiedBy).toBe('agent');
	});

	it('keeps the rules when the planner answers nonsense', () => {
		const fallback = classifyByRules('Something about invoices.', modules);
		expect(
			parsePlan('I cannot help.', modules, DEFAULT_AGENT_ROLES, fallback),
		).toBe(fallback);
		const plan = parsePlan(
			'{"kind":"new-module","moduleId":"billing.core","firstRole":"nobody"}',
			modules,
			DEFAULT_AGENT_ROLES,
			fallback,
		);
		expect(plan.moduleId).toBe('billing.core');
		expect(plan.modules).toEqual([
			{ id: 'billing.core', directory: 'billing', kind: 'new' },
		]);
		expect(plan.firstRole).toBe(fallback.firstRole);
	});

	it('rejects a brief that says nothing', () => {
		expect(() => assertBrief('  hi  ')).toThrow(/at least 8 characters/);
		expect(assertBrief('  Build a profile screen  ')).toBe(
			'Build a profile screen',
		);
	});
});

const SESSION: SandboxSession = {
	id: '00000000-0000-4000-8000-000000000000',
	kind: 'new-module',
	moduleId: 'profile.core',
	moduleSuffix: 'profile',
	modules: [{ id: 'profile.core', directory: 'profile', kind: 'new' }],
	title: 'User profile',
	brief: 'A screen where a user changes their display name.',
	blueprint: 'new-module@1.0.0',
	role: 'business-manager',
	driver: 'codex',
	model: null,
	resumeIds: {},
	autoContinue: true,
	chainDepth: 0,
	attachments: [],
	checkpoints: [],
	state: 'draft',
	createdAt: 0,
	updatedAt: 0,
	ejectedAt: null,
	archivedAt: null,
	registeredWithPlatform: false,
};

describe('turn routing', () => {
	const roles = DEFAULT_AGENT_ROLES;
	const paths = sessionPaths('/tmp/workspace', SESSION.id, 'profile');
	const base = {
		session: SESSION,
		paths,
		roles,
		message: 'Do the work.',
		specApproved: true as boolean | null,
	};

	it('starts with the specification when there is none', () => {
		expect(
			routeRole({
				...base,
				hasSpec: false,
				hasManifest: false,
				hasServer: false,
				hasClient: false,
			}).role,
		).toBe('business-manager');
	});

	it('moves to the server once the specification exists', () => {
		expect(
			routeRole({
				...base,
				hasSpec: true,
				hasManifest: false,
				hasServer: false,
				hasClient: false,
			}).role,
		).toBe('backend-engineer');
	});

	it('moves to the client once the server exists', () => {
		expect(
			routeRole({
				...base,
				hasSpec: true,
				hasManifest: true,
				hasServer: true,
				hasClient: false,
			}).role,
		).toBe('frontend-engineer');
	});

	it('follows the words of the request inside a valid state', () => {
		expect(
			routeRole({
				...base,
				message: 'Add a dashboard widget with the weekly total.',
				hasSpec: true,
				hasManifest: true,
				hasServer: true,
				hasClient: true,
			}).role,
		).toBe('frontend-engineer');
		expect(
			routeRole({
				...base,
				message: 'Expose an agent tool that reads the weekly summary.',
				hasSpec: true,
				hasManifest: true,
				hasServer: true,
				hasClient: true,
			}).role,
		).toBe('agentic-engineer');
	});

	it('sends an answer back to the specialist who asked the question', () => {
		expect(
			routeRole({
				...base,
				message: '1. Owner only. 2. One role only.',
				hasSpec: true,
				hasManifest: true,
				hasServer: true,
				hasClient: true,
				lastHandoff: {
					kind: 'question',
					role: 'business-manager',
					roleName: 'Business manager',
					reason: 'Needs decisions.',
					prompt: '',
				},
			}),
		).toMatchObject({ role: 'business-manager' });
	});
});

describe('declared dependencies', () => {
	it('reports a package the sources import but the manifest omits', async () => {
		const root = await mkdtemp(join(tmpdir(), 'coreloom-deps-'));
		await mkdir(join(root, 'src/client'), { recursive: true });
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ dependencies: { '@coreloom/server': 'workspace:*' } }),
			'utf8',
		);
		await writeFile(
			join(root, 'src/client/View.tsrx'),
			[
				"import { readFile } from 'node:fs/promises';",
				"import { Button } from '@coreloom/ui';",
				"import { defineEndpoint } from '@coreloom/server';",
				"import { useValue } from 'segment-state';",
				"import { local } from './state.ts';",
				'export const view = [readFile, Button, defineEndpoint, useValue, local];',
			].join('\n'),
			'utf8',
		);

		const report = await checkDeclaredDependencies(root);
		expect(report.imported).toEqual([
			'@coreloom/server',
			'@coreloom/ui',
			'segment-state',
		]);
		expect(report.missing).toEqual(['@coreloom/ui', 'segment-state']);
	});

	it('accepts a module whose manifest covers every import', async () => {
		const root = await mkdtemp(join(tmpdir(), 'coreloom-deps-'));
		await mkdir(join(root, 'src'), { recursive: true });
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				dependencies: { octane: '0.1.50' },
				devDependencies: { vitest: '4.1.10' },
			}),
			'utf8',
		);
		await writeFile(
			join(root, 'src/index.ts'),
			"import { useEffect } from 'octane';\nexport const used = useEffect;\n",
			'utf8',
		);
		expect((await checkDeclaredDependencies(root)).missing).toEqual([]);
	});
});

describe('boot shell', () => {
	it('paints a splash outside the hydration root and waits for the app', async () => {
		const html = await readFile(
			new URL('../index.html', import.meta.url),
			'utf8',
		);
		expect(html.indexOf('id="coreloom-splash"')).toBeLessThan(
			html.indexOf('id="root"'),
		);
		expect(html).toContain('role="status"');
		expect(html).toContain("window.addEventListener('coreloom:ready', finish");
		expect(html).toContain("'Probing coding agents'");
		expect(html).toMatch(
			/<noscript[\s\S]*\.coreloom-splash\s*{\s*display:\s*none;/,
		);
	});
});

describe('handoff planning', () => {
	const roles = DEFAULT_AGENT_ROLES;
	const routing = {
		session: SESSION,
		paths: sessionPaths('/tmp/workspace', SESSION.id, 'profile'),
		roles,
		message: 'Build it.',
		hasSpec: true,
		hasManifest: false,
		hasServer: false,
		hasClient: false,
		specApproved: true as boolean | null,
	};
	const base = {
		routing,
		role: 'business-manager',
		module: 'profile',
		declared: null,
		gates: [],
		failed: false,
		changed: true,
		specApproved: true as boolean | null,
		brief: SESSION.brief,
	};

	it('sends the work on to the specialist the agent named', () => {
		const plan = planHandoff({
			...base,
			declared: { role: 'ux-designer', reason: 'the screen is missing' },
		});
		expect(plan.kind).toBe('continue');
		expect(plan.role).toBe('ux-designer');
		expect(plan.prompt).toContain('Continue this work as UX designer.');
		expect(plan.prompt).toContain(SESSION.brief);
	});

	it('falls back to the deterministic route when no line was written', () => {
		const plan = planHandoff(base);
		expect(plan.kind).toBe('continue');
		expect(plan.role).toBe('backend-engineer');
	});

	it('ignores a handoff to a role outside the list, or to itself', () => {
		const outside = planHandoff({
			...base,
			role: 'backend-engineer',
			routing: { ...routing, hasManifest: true, hasServer: true },
			declared: { role: 'business-manager', reason: 'spec first' },
		});
		expect(outside.role).toBe('frontend-engineer');
		expect(outside.reason).toContain('may not hand off to Business manager');

		const self = planHandoff({
			...base,
			declared: { role: 'business-manager', reason: 'more to write' },
		});
		expect(self.role).toBe('backend-engineer');
		expect(self.reason).toContain('named itself');
	});

	it('stops for the operator while the specification is a draft', () => {
		const plan = planHandoff({ ...base, specApproved: false });
		expect(plan.kind).toBe('approval');
		expect(plan.role).toBe('backend-engineer');
		expect(plan.prompt).toContain('Continue this work as Backend engineer.');
	});

	it('asks instead of offering approval when the draft still needs facts', () => {
		const plan = planHandoff({
			...base,
			specApproved: false,
			changed: false,
			declared: { role: null, reason: 'who may approve a booking?' },
		});
		expect(plan.kind).toBe('question');
		expect(plan.reason).toContain('who may approve');
	});

	it('keeps a failed gate with the specialist that caused it and quotes the output', () => {
		const plan = planHandoff({
			...base,
			declared: { role: 'ux-designer', reason: 'the screen is missing' },
			gates: [
				{
					id: 'tests' as const,
					module: 'profile',
					status: 'failed' as const,
					command: 'vitest run',
					output: 'FAIL tests/roles.test.ts > no such column: tenant_id',
					durationMs: 1,
				},
			],
		});
		expect(plan.kind).toBe('continue');
		expect(plan.role).toBe('business-manager');
		expect(plan.prompt).toContain('tests (modules/profile) gate failed');
		expect(plan.prompt).toContain('no such column: tenant_id');
		expect(plan.prompt).toContain('vitest run');
	});

	it('never continues on its own after a driver error', () => {
		expect(planHandoff({ ...base, failed: true }).kind).toBe('blocked');
	});

	it('asks for a review when the agent reports the work finished', () => {
		const plan = planHandoff({
			...base,
			declared: {
				role: null,
				reason: 'everything the request asked for exists',
			},
		});
		expect(plan.kind).toBe('review');
		expect(plan.reason).toContain('everything the request asked for');
	});

	it('turns a turn that changed nothing into a question for the operator', () => {
		const plan = planHandoff({
			...base,
			changed: false,
			declared: { role: null, reason: 'the request needs a tenancy decision' },
		});
		expect(plan.kind).toBe('question');
		expect(plan.role).toBe('business-manager');
	});

	it('hands an updated specification of an existing module to the implementer', () => {
		const plan = planHandoff({
			...base,
			routing: {
				...routing,
				session: { ...SESSION, kind: 'edit-module' },
				hasManifest: true,
				hasServer: true,
				hasClient: true,
			},
			specApproved: null,
			declared: { role: null, reason: 'the spec now covers custom roles' },
		});
		expect(plan.kind).toBe('continue');
		expect(plan.role).toBe('backend-engineer');
	});
});

describe('specification approval', () => {
	it('moves the status line and nothing else', async () => {
		const root = await workspace();
		const session = await createSession({
			workspaceRoot: root,
			kind: 'new-module',
			moduleId: 'profile.core',
			title: 'User profile',
			brief: 'A screen where a user changes their display name.',
			blueprint: 'new-module@1.0.0',
			role: 'business-manager',
			driver: 'codex',
			install: false,
		});
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await mkdir(join(paths.modulePath, 'spec'), { recursive: true });
		await writeFile(
			join(paths.modulePath, 'spec', 'module.yaml'),
			'schemaVersion: 1\nid: profile.core\nstatus: draft\nname: Profile\n',
			'utf8',
		);

		const approved = await approveSpecification(root, session);
		expect(approved.status).toBe('approved');
		expect(approved.session.state).toBe('planned');
		expect(
			await readFile(join(paths.modulePath, 'spec', 'module.yaml'), 'utf8'),
		).toBe(
			'schemaVersion: 1\nid: profile.core\nstatus: approved\nname: Profile\n',
		);
	});

	it('refuses a session that has no specification yet', async () => {
		const root = await workspace();
		const session = await createSession({
			workspaceRoot: root,
			kind: 'new-module',
			moduleId: 'profile.core',
			title: 'User profile',
			brief: 'A screen where a user changes their display name.',
			blueprint: 'new-module@1.0.0',
			role: 'business-manager',
			driver: 'codex',
			install: false,
		});
		await expect(approveSpecification(root, session)).rejects.toThrow(
			/no specification/,
		);
	});
});
