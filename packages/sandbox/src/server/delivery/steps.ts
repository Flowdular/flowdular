import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import type { GateResult } from '../gates.ts';
import { modulePathOf, type SessionPaths } from '../sessions.ts';
import { SandboxSetupError } from '../workspace-root.ts';
import type {
	DeliveryContext,
	DeliveryEmit,
	DeliveryModulePlan,
	DeliveryStepResult,
} from './types.ts';

export interface CommandResult {
	readonly code: number | null;
	readonly output: string;
}

export interface CommandOptions {
	/* Replaces the inherited environment entirely when given. */
	readonly env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (
	command: string,
	args: readonly string[],
	cwd: string,
	options?: CommandOptions,
) => Promise<CommandResult>;

export interface StepResult {
	readonly ok: boolean;
	readonly output: string;
	/* One line worth showing next to a passed step (a URL, a count). */
	readonly detail?: string;
}

export class DeliveryError extends SandboxSetupError {
	constructor(
		code: string,
		message: string,
		readonly output: string = '',
	) {
		super(code, message);
		this.name = 'DeliveryError';
	}
}

const OUTPUT_LIMIT = 8_000;

export const spawnCommand: CommandRunner = (command, args, cwd, options) =>
	new Promise((resolvePromise) => {
		const child = spawn(command, [...args], {
			cwd,
			env: options?.env ?? { ...process.env, FORCE_COLOR: '0' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let output = '';
		const append = (chunk: string) => {
			output = (output + chunk).slice(-OUTPUT_LIMIT);
		};
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		child.on('error', (error) =>
			resolvePromise({ code: null, output: error.message }),
		);
		child.on('close', (code) => resolvePromise({ code, output }));
	});

/* Only module sources travel. Dependencies, the reference material, and the
   session's own scratch state never enter the workspace. */
const EXCLUDED = new Set(['node_modules', 'dist', '.turbo']);

export async function listModuleFiles(
	root: string,
	directory = root,
): Promise<string[]> {
	const files: string[] = [];
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of entries) {
		if (EXCLUDED.has(entry.name)) continue;
		if (entry.isSymbolicLink()) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listModuleFiles(root, path)));
		else files.push(relative(root, path));
	}
	return files.sort();
}

export async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/* What one module's delivery changes in the workspace: every draft file, the
   ones that differ from what is there, and the files the session deleted
   relative to the copy it started from. */
export async function planModuleFiles(
	sourcePath: string,
	targetPath: string,
	basePath: string | null,
): Promise<{
	readonly files: readonly string[];
	readonly additions: readonly string[];
	readonly overwrites: readonly string[];
	readonly removes: readonly string[];
}> {
	const files = await listModuleFiles(sourcePath);
	const additions: string[] = [];
	const overwrites: string[] = [];
	for (const file of files) {
		const current = join(targetPath, file);
		if (!(await exists(current))) {
			additions.push(file);
			continue;
		}
		const [before, after] = await Promise.all([
			readFile(current, 'utf8').catch(() => null),
			readFile(join(sourcePath, file), 'utf8').catch(() => null),
		]);
		if (before !== after) overwrites.push(file);
	}
	const present = new Set(files);
	const removes = basePath
		? (await listModuleFiles(basePath)).filter((file) => !present.has(file))
		: [];
	return { files, additions, overwrites, removes };
}

async function resolutionBases(
	workspaceRoot: string,
	targetPath: string,
): Promise<readonly string[]> {
	const bases = [targetPath];
	try {
		for (const entry of await readdir(join(workspaceRoot, 'modules'))) {
			bases.push(join(workspaceRoot, 'modules', entry));
		}
	} catch {
		/* A workspace with no modules yet resolves from its root only. */
	}
	bases.push(workspaceRoot);
	return bases;
}

/* A package counts as present when any module of this workspace can already
   resolve it, because pnpm links the same store entry for the new module. */
export async function newPackages(
	workspaceRoot: string,
	modulePath: string,
	targetPath: string,
): Promise<readonly string[]> {
	let declared: Record<string, string> = {};
	try {
		const manifest = JSON.parse(
			await readFile(join(modulePath, 'package.json'), 'utf8'),
		) as { dependencies?: Record<string, string> };
		declared = manifest.dependencies ?? {};
	} catch {
		return [];
	}
	const bases = await resolutionBases(workspaceRoot, targetPath);
	const resolvers = bases.map((base) => createRequire(join(base, 'index.js')));
	const missing: string[] = [];
	for (const [name, range] of Object.entries(declared)) {
		if (range.startsWith('workspace:')) continue;
		const resolved = resolvers.some((resolver) => {
			try {
				resolver.resolve(`${name}/package.json`);
				return true;
			} catch {
				try {
					resolver.resolve(name);
					return true;
				} catch {
					return false;
				}
			}
		});
		if (!resolved) missing.push(`${name}@${range}`);
	}
	return missing.sort();
}

/* Gates run one at a time so the screen shows which one is running; a failing
   gate stops the delivery before any file is written. */
export async function runDeliveryGates(
	context: DeliveryContext,
	gates: readonly string[],
	emit: DeliveryEmit,
): Promise<readonly GateResult[]> {
	const results: GateResult[] = [];
	for (const gate of gates) {
		emit('gate.started', { id: gate });
		for (const result of await context.runGates([gate])) {
			results.push(result);
			emit('gate.completed', result);
		}
	}
	assertGatesPassed(results);
	return results;
}

/* Copies every module of the plan under `targetRoot`, then removes what the
   session deleted, reporting counts as the workspace target always has. */
export async function stageModules(
	paths: SessionPaths,
	targetRoot: string,
	modules: readonly DeliveryModulePlan[],
	emit: DeliveryEmit,
): Promise<{ readonly copied: number; readonly removed: number }> {
	let copied = 0;
	let removed = 0;
	for (const module of modules) {
		const sourcePath = modulePathOf(paths, module.directory);
		const targetPath = join(targetRoot, module.targetPath);
		emit('copy.started', { module: module.id, files: module.files.length });
		copied += (await stageModuleFiles(sourcePath, targetPath, module.files))
			.length;
		emit('copy.completed', { module: module.id, files: copied });
		if (module.removes.length > 0) {
			emit('remove.started', {
				module: module.id,
				files: module.removes.length,
			});
			removed += (await removeModuleFiles(targetPath, module.removes)).length;
			emit('remove.completed', { module: module.id, files: removed });
		}
	}
	return { copied, removed };
}

export function assertGatesPassed(gates: readonly GateResult[]): void {
	const failed = gates.filter((gate) => gate.status === 'failed');
	if (failed.length > 0) {
		throw new DeliveryError(
			'EJECT_GATES_FAILED',
			`Eject is blocked by failing gates: ${failed
				.map((gate) => (gate.module ? `${gate.id} (${gate.module})` : gate.id))
				.join(', ')}.`,
			failed.map((gate) => gate.output).join('\n\n'),
		);
	}
}

export async function stageModuleFiles(
	sourcePath: string,
	targetPath: string,
	files: readonly string[],
): Promise<readonly string[]> {
	for (const file of files) {
		const destination = join(targetPath, file);
		await mkdir(dirname(destination), { recursive: true });
		await cp(join(sourcePath, file), destination);
	}
	return files;
}

/* Removes what the session deleted, then the directories that became empty,
   so an update never leaves a stale file the draft no longer has. */
export async function removeModuleFiles(
	targetPath: string,
	files: readonly string[],
): Promise<readonly string[]> {
	for (const file of files) {
		await rm(join(targetPath, file), { force: true });
		let directory = dirname(join(targetPath, file));
		while (directory !== targetPath && directory.startsWith(targetPath)) {
			try {
				if ((await readdir(directory)).length > 0) break;
				await rm(directory, { recursive: true });
			} catch {
				break;
			}
			directory = dirname(directory);
		}
	}
	return files;
}

export function step(
	result: CommandResult,
	detail?: string,
	limit = 2_000,
): StepResult {
	return {
		ok: result.code === 0,
		output: result.output.slice(-limit),
		...(detail ? { detail } : {}),
	};
}

export interface StepRecorder {
	readonly steps: readonly DeliveryStepResult[];
	/* Emits `<id>.completed` and throws on the first failing step, so a target
	   never continues past a failure. */
	record(id: string, result: StepResult): void;
}

export function createStepRecorder(emit: DeliveryEmit): StepRecorder {
	const steps: DeliveryStepResult[] = [];
	return {
		steps,
		record(id, result) {
			steps.push({ id, ...result });
			emit(`${id}.completed`, result);
			if (!result.ok) {
				throw new DeliveryError(
					'EJECT_STEP_FAILED',
					`The ${id} step failed, so the delivery stopped there. ${result.output.trim().split('\n').at(-1) ?? ''}`.trim(),
					result.output,
				);
			}
		},
	};
}

/* A worktree starts without node_modules. The store already holds everything
   the workspace resolved, so the install is offline first and only reaches the
   registry when a module declares something new. */
export async function installWorktree(
	run: CommandRunner,
	worktreeRoot: string,
): Promise<StepResult> {
	const offline = await run(
		'pnpm',
		['--dir', worktreeRoot, 'install', '--offline'],
		worktreeRoot,
	);
	if (offline.code === 0) return step(offline);
	return step(
		await run(
			'pnpm',
			['--dir', worktreeRoot, 'install', '--prefer-offline'],
			worktreeRoot,
		),
	);
}

/* A copied module brings its own dependencies. Linking them before anything
   else runs is what keeps the workspace importable right after an eject. */
export async function installWorkspace(
	run: CommandRunner,
	workspaceRoot: string,
): Promise<StepResult> {
	return step(
		await run(
			'pnpm',
			['--dir', workspaceRoot, 'install', '--silent'],
			workspaceRoot,
		),
	);
}

export async function enableModule(
	run: CommandRunner,
	workspaceRoot: string,
	moduleId: string,
): Promise<StepResult> {
	return step(
		await run(
			'pnpm',
			[
				'--dir',
				workspaceRoot,
				'--silent',
				'coreloom',
				'module',
				'enable',
				moduleId,
				'--apply',
				'--json',
			],
			workspaceRoot,
		),
	);
}

/* A module brings its own scopes. Without this step it is installed, enabled,
   and invisible, because nobody holds the permission its navigation requires. */
export async function syncModuleScopes(
	run: CommandRunner,
	workspaceRoot: string,
	moduleId: string,
): Promise<StepResult> {
	return step(
		await run(
			'pnpm',
			[
				'--dir',
				workspaceRoot,
				'--silent',
				'coreloom',
				'auth',
				'sync-scopes',
				'--module',
				moduleId,
				'--apply',
				'--json',
			],
			workspaceRoot,
		),
	);
}

export async function verifyPlatform(
	run: CommandRunner,
	workspaceRoot: string,
): Promise<StepResult> {
	return step(
		await run(
			'pnpm',
			['--dir', workspaceRoot, '--filter', '@coreloom/platform', 'typecheck'],
			workspaceRoot,
		),
	);
}

export async function buildWorkspace(
	run: CommandRunner,
	workspaceRoot: string,
): Promise<StepResult> {
	return step(
		await run('pnpm', ['--dir', workspaceRoot, 'build'], workspaceRoot),
	);
}
