import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { checkDeclaredDependencies } from './dependencies.ts';
import {
	modulePathOf,
	type SandboxSession,
	type SessionModule,
	type SessionPaths,
} from './sessions.ts';

export type GateId =
	| 'spec-schema'
	| 'module-schema'
	| 'dependencies'
	| 'typecheck'
	| 'tests'
	| 'format';

export interface GateResult {
	readonly id: GateId;
	/* The draft module directory a module-level gate ran in; absent for a gate
	   that checks the whole session workspace. */
	readonly module?: string;
	readonly status: 'passed' | 'failed' | 'skipped';
	readonly durationMs: number;
	readonly command: string;
	readonly output: string;
}

interface GateDefinition {
	readonly id: GateId;
	readonly summary: string;
	/* Workspace gates run once per session; module gates run per draft module. */
	readonly scope: 'workspace' | 'module';
	command(context: GateContext): {
		readonly command: string;
		readonly args: readonly string[];
		readonly cwd: string;
	} | null;
	/* A gate the sandbox answers itself, without spawning a process. */
	inspect?(context: GateContext): Promise<{
		readonly passed: boolean;
		readonly output: string;
	}>;
}

interface GateContext {
	readonly workspaceRoot: string;
	readonly paths: SessionPaths;
	readonly session: SandboxSession;
	readonly module: SessionModule;
	readonly modulePath: string;
}

/* Output keeps its head and its tail: the head names what failed (the test
   list, the first compiler errors), the tail carries the summary. */
const HEAD_LIMIT = 10_000;
const TAIL_LIMIT = 6_000;
const GATE_TIMEOUT_MS = 5 * 60 * 1000;

/* The only commands the sandbox may run. Agents never execute anything: they
   request a gate by id and the orchestrator runs this fixed list. */
const GATE_DEFINITIONS: readonly GateDefinition[] = [
	{
		id: 'spec-schema',
		summary: 'Validate the module specification against its schema.',
		scope: 'workspace',
		command: (context) => ({
			command: 'pnpm',
			args: [
				'--dir',
				context.workspaceRoot,
				'--silent',
				'oerp',
				'spec',
				'validate',
				'--all',
				'--json',
				'--root',
				context.paths.workspace,
			],
			cwd: context.workspaceRoot,
		}),
	},
	{
		id: 'module-schema',
		summary: 'Validate the module manifest and registry references.',
		scope: 'workspace',
		command: (context) => ({
			command: 'pnpm',
			args: [
				'--dir',
				context.workspaceRoot,
				'--silent',
				'oerp',
				'module',
				'validate',
				'--json',
				'--root',
				context.paths.workspace,
				/* The other modules in the session are manifest-only copies for the
				   registry graph; file-level checks run against the drafts only. */
				'--module',
				context.session.modules.map((entry) => entry.id).join(','),
			],
			cwd: context.workspaceRoot,
		}),
	},
	{
		id: 'dependencies',
		summary: 'Every imported package is declared by the module manifest.',
		scope: 'module',
		command: () => null,
		inspect: async (context) => {
			const report = await checkDeclaredDependencies(context.modulePath);
			return {
				passed: report.missing.length === 0,
				output:
					report.missing.length === 0
						? `${report.imported.length} imported packages, all declared.`
						: `Undeclared packages: ${report.missing.join(', ')}. Add them to package.json dependencies; the session installs what package.json declares and nothing else, and the ejected module would fail without them.`,
			};
		},
	},
	{
		id: 'typecheck',
		summary: 'Typecheck the module with the workspace compiler.',
		scope: 'module',
		command: (context) => ({
			command: join(context.modulePath, 'node_modules', '.bin', 'tsrx-tsc'),
			args: ['--noEmit', '-p', 'tsconfig.json'],
			cwd: context.modulePath,
		}),
	},
	{
		id: 'tests',
		summary: 'Run the module test suite.',
		scope: 'module',
		command: (context) => ({
			command: join(context.modulePath, 'node_modules', '.bin', 'vitest'),
			args: ['run', '--passWithNoTests'],
			cwd: context.modulePath,
		}),
	},
	{
		id: 'format',
		summary: 'Check formatting with the workspace Prettier configuration.',
		scope: 'module',
		command: (context) => ({
			command: join(context.workspaceRoot, 'node_modules', '.bin', 'prettier'),
			args: ['--check', '.'],
			cwd: context.modulePath,
		}),
	},
];

export const GATE_IDS = GATE_DEFINITIONS.map((gate) => gate.id);

/* Formatting is mechanical, so the sandbox fixes it on request instead of
   spending an agent turn on it. It is still the orchestrator running the
   command, never the model. */
export async function formatDirectory(
	workspaceRoot: string,
	directory: string,
): Promise<GateResult> {
	const command = join(workspaceRoot, 'node_modules', '.bin', 'prettier');
	const startedAt = Date.now();
	try {
		await access(command);
	} catch {
		return {
			id: 'format',
			status: 'skipped',
			durationMs: 0,
			command,
			output: 'Prettier is not installed in this workspace.',
		};
	}
	const result = await runProcess(command, ['--write', '.'], directory);
	return {
		id: 'format',
		status: result.code === 0 ? 'passed' : 'failed',
		durationMs: Date.now() - startedAt,
		command: `${command} --write .`,
		output: result.output.trim(),
	};
}

export async function formatSession(context: {
	readonly workspaceRoot: string;
	readonly paths: SessionPaths;
	readonly session: SandboxSession;
}): Promise<readonly GateResult[]> {
	const results: GateResult[] = [];
	for (const module of context.session.modules) {
		results.push({
			...(await formatDirectory(
				context.workspaceRoot,
				modulePathOf(context.paths, module.directory),
			)),
			module: module.directory,
		});
	}
	return results;
}

export function isGateId(value: string): value is GateId {
	return (GATE_IDS as readonly string[]).includes(value);
}

function runProcess(
	command: string,
	args: readonly string[],
	cwd: string,
): Promise<{ code: number | null; output: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn(command, [...args], {
			cwd,
			env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let head = '';
		let tail = '';
		let omitted = 0;
		const append = (chunk: string) => {
			if (head.length < HEAD_LIMIT) {
				const room = HEAD_LIMIT - head.length;
				head += chunk.slice(0, room);
				chunk = chunk.slice(room);
				if (!chunk) return;
			}
			const kept = (tail + chunk).slice(-TAIL_LIMIT);
			omitted += tail.length + chunk.length - kept.length;
			tail = kept;
		};
		const output = () =>
			omitted > 0
				? `${head}\n[... ${omitted} characters omitted ...]\n${tail}`
				: head + tail;
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		const timer = setTimeout(() => {
			append('\nThe gate exceeded its time budget and was stopped.');
			child.kill('SIGKILL');
		}, GATE_TIMEOUT_MS);
		timer.unref();
		child.on('error', (error) => {
			clearTimeout(timer);
			resolvePromise({ code: null, output: `${output()}\n${error.message}` });
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolvePromise({ code, output: output() });
		});
	});
}

async function runGate(
	definition: GateDefinition,
	context: GateContext,
): Promise<GateResult> {
	const id = definition.id;
	const module =
		definition.scope === 'module' ? { module: context.module.directory } : {};
	const startedAt = Date.now();
	if (definition.inspect) {
		const result = await definition.inspect(context);
		return {
			id,
			...module,
			status: result.passed ? 'passed' : 'failed',
			durationMs: Date.now() - startedAt,
			command: definition.summary,
			output: result.output,
		};
	}
	const invocation = definition.command(context);
	if (!invocation) {
		return {
			id,
			...module,
			status: 'skipped',
			durationMs: 0,
			command: '',
			output: 'This gate does not apply to the session.',
		};
	}
	const printable = `${invocation.command} ${invocation.args.join(' ')}`;
	if (invocation.command.includes('/')) {
		try {
			await access(invocation.command);
		} catch {
			return {
				id,
				...module,
				status: 'skipped',
				durationMs: 0,
				command: printable,
				output: `${invocation.command} is not installed in this session workspace. The module's package.json must declare it as a devDependency.`,
			};
		}
	}
	const result = await runProcess(
		invocation.command,
		invocation.args,
		invocation.cwd,
	);
	return {
		id,
		...module,
		status: result.code === 0 ? 'passed' : 'failed',
		durationMs: Date.now() - startedAt,
		command: printable,
		output: result.output.trim(),
	};
}

export interface RunGatesInput {
	readonly workspaceRoot: string;
	readonly paths: SessionPaths;
	readonly session: SandboxSession;
	readonly gates: readonly GateId[];
}

/* Workspace gates run once; module gates run once per draft module, so a
   session that touches several modules reports each of them. */
export async function runGates(
	input: RunGatesInput,
): Promise<readonly GateResult[]> {
	const results: GateResult[] = [];
	for (const id of input.gates) {
		const definition = GATE_DEFINITIONS.find((gate) => gate.id === id)!;
		const targets =
			definition.scope === 'workspace'
				? input.session.modules.slice(0, 1)
				: input.session.modules;
		for (const module of targets) {
			results.push(
				await runGate(definition, {
					workspaceRoot: input.workspaceRoot,
					paths: input.paths,
					session: input.session,
					module,
					modulePath: modulePathOf(input.paths, module.directory),
				}),
			);
		}
	}
	return results;
}
