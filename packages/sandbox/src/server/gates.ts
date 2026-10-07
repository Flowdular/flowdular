import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, matchesGlob } from 'node:path';
import { inspectAutoReview } from './auto-review.ts';
import { checkDeclaredDependencies } from './dependencies.ts';
import { checkModuleRules } from './module-rules.ts';
import {
	LIVE_ADAPTER_REFUSED,
	liveAdapterRefusal,
	readSessionAdapters,
} from './recorded-adapters.ts';
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
	| 'module-rules'
	| 'typecheck'
	| 'tests'
	| 'format'
	| 'auto-review';

export interface GateResult {
	readonly id: GateId;
	/* The draft module directory a module-level gate ran in; absent for a gate
	   that checks the whole session workspace. */
	readonly module?: string;
	readonly status: 'passed' | 'failed' | 'skipped';
	readonly durationMs: number;
	readonly command: string;
	readonly output: string;
	/* The errors a failed validator reported, read from its own standard
	   output before the output bound cut it. Absent for a gate that is not a
	   validator (a test run, a typecheck) and for one whose standard output
	   held no envelope. */
	readonly issues?: readonly GateIssue[];
	/* Errors past MAX_GATE_ISSUES, counted rather than dropped in silence. */
	readonly moreIssues?: number;
}

/* One error a validator reported, in the words of the CLI envelope. A failure
   the envelope does not tie to a file, such as an enabled module without a
   manifest, has no file. */
export interface GateIssue {
	readonly file?: string;
	readonly code: string;
	readonly path?: string;
	readonly message: string;
}

/* What the transcript keeps of a gate result to show it as a result. The
   entry text still carries the command and the full output the next turn
   reads; this is the part a reader needs first. */
export type GateSummary = Pick<
	GateResult,
	'id' | 'module' | 'status' | 'issues' | 'moreIssues'
>;

/* A gate as the session tracks it: a module gate per draft module. */
export type GateKey = Pick<GateResult, 'id' | 'module'>;

export const MAX_GATE_ISSUES = 20;

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
		readonly issues?: readonly GateIssue[];
	}>;
	/* A sandbox rule checked beside the command; a refusal fails the gate. */
	refuse?(context: GateContext): Promise<{
		readonly code: string;
		readonly message: string;
	} | null>;
	/* The command prints the CLI envelope on standard output, so a failure
	   is read as the errors it reports. */
	readonly envelope?: true;
	/* Module files the gate checks, relative to the module. A turn that wrote
	   one runs the gate whatever its role lists. Auto-review has none: any
	   write invalidates its evidence, and the review handoff records it. */
	readonly reads?: readonly string[];
}

interface GateContext {
	readonly workspaceRoot: string;
	readonly paths: SessionPaths;
	readonly session: SandboxSession;
	readonly module: SessionModule;
	readonly modulePath: string;
	readonly signal?: AbortSignal | undefined;
}

/* Output keeps its head and its tail: the head names what failed (the test
   list, the first compiler errors), the tail carries the summary. */
const HEAD_LIMIT = 10_000;
const TAIL_LIMIT = 6_000;
/* An envelope holds a report for every specification or manifest in the
   workspace and outgrows the output bound long before this one. Standard
   output past it is not read as an envelope at all. */
const ENVELOPE_LIMIT = 4_000_000;
const GATE_TIMEOUT_MS = 5 * 60 * 1000;

/* The only commands the sandbox may run. Agents never execute anything: they
   request a gate by id and the orchestrator runs this fixed list. */
const GATE_DEFINITIONS: readonly GateDefinition[] = [
	{
		id: 'auto-review',
		summary: 'Review evidence matches the current module contents.',
		scope: 'module',
		command: () => null,
		inspect: (context) => inspectAutoReview(context.paths, context.module),
	},
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
				'flowdular',
				'spec',
				'validate',
				'--all',
				'--json',
				'--root',
				context.paths.workspace,
			],
			cwd: context.workspaceRoot,
		}),
		envelope: true,
		reads: ['spec/**'],
		refuse: async (context) => {
			const refusal = liveAdapterRefusal(
				(
					await readSessionAdapters(
						context.session.modules.map((module) => ({
							directory: module.directory,
							path: modulePathOf(context.paths, module.directory),
						})),
					)
				).live,
			);
			return refusal
				? {
						code: LIVE_ADAPTER_REFUSED,
						message: refusal.slice(`${LIVE_ADAPTER_REFUSED}: `.length),
					}
				: null;
		},
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
				'flowdular',
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
		envelope: true,
		reads: [
			'module.json',
			'package.json',
			'spec/**',
			'translations/**',
			'src/client/**',
			'src/platform.ts',
			'migrations/**',
		],
	},
	{
		id: 'dependencies',
		summary: 'Every imported package is declared by the module manifest.',
		scope: 'module',
		command: () => null,
		reads: ['package.json', 'src/**'],
		inspect: async (context) => {
			const report = await checkDeclaredDependencies(context.modulePath);
			if (report.missing.length === 0)
				return {
					passed: true,
					output: `${report.imported.length} imported packages, all declared.`,
				};
			const output = `Undeclared packages: ${report.missing.join(', ')}. Add them to package.json dependencies; the session installs what package.json declares and nothing else, and the ejected module would fail without them.`;
			return {
				passed: false,
				output,
				issues: [
					{
						code: 'DEPENDENCY_UNDECLARED',
						path: 'package.json',
						message: output.slice(0, 500),
					},
				],
			};
		},
	},
	{
		id: 'module-rules',
		summary:
			'The module satisfies the deterministic rules: declared permissions, a permission on every endpoint, tenant identity from the principal, forced row-level security, mirrored migrations, complete locales and no interpolated statement.',
		scope: 'module',
		command: () => null,
		/* The specification and its terminology are what the build is measured
		   against, and the business manager changes them ahead of the build;
		   the key check covers the bundles. */
		reads: ['src/**', 'migrations/**'],
		inspect: async (context) => {
			const specPath = join(context.modulePath, 'spec', 'module.yaml');
			let spec = '';
			try {
				spec = await readFile(specPath, 'utf8');
			} catch {
				return {
					passed: false,
					output: `${specPath} could not be read, so the module cannot be measured against its specification.`,
					issues: [
						{
							code: 'SPEC_UNREADABLE',
							path: 'spec/module.yaml',
							message:
								'The specification could not be read, so the module cannot be measured against it.',
						},
					],
				};
			}
			return checkModuleRules({ modulePath: context.modulePath, spec });
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
		reads: [
			'tsconfig.json',
			'package.json',
			'src/**',
			'tests/**',
			'translations/**',
		],
	},
	{
		id: 'tests',
		summary: 'Run the module test suite.',
		scope: 'module',
		command: (context) => ({
			command: join(context.modulePath, 'node_modules', '.bin', 'vitest'),
			args: ['run', '--passWithNoTests=false'],
			cwd: context.modulePath,
		}),
		reads: [
			'package.json',
			'tsconfig.json',
			'vitest.config.ts',
			'src/**',
			'tests/**',
			'translations/**',
			'migrations/**',
			'preview/**',
			'adapters/**',
			'templates/**',
			'research-fixtures.json',
		],
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
		reads: ['**'],
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
	/* An operator asked for this directly, so it is not tied to a turn and has
	   no turn signal to observe. */
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

/* The gates that check a file a turn wrote (workspace paths, as the path
   guard reports them) in one of the named module directories. */
export function gatesReading(
	written: readonly string[],
	modules: readonly string[],
): GateId[] {
	return GATE_DEFINITIONS.filter((gate) =>
		gate.reads?.some((pattern) =>
			modules.some((module) =>
				written.some((path) =>
					matchesGlob(path, `modules/${module}/${pattern}`),
				),
			),
		),
	).map((gate) => gate.id);
}

export function summarizeGate(gate: GateResult): GateSummary {
	return {
		id: gate.id,
		...(gate.module ? { module: gate.module } : {}),
		status: gate.status,
		...(gate.issues ? { issues: gate.issues } : {}),
		...(gate.moreIssues ? { moreIssues: gate.moreIssues } : {}),
	};
}

type Fields = Readonly<Record<string, unknown>>;

function fields(value: unknown): Fields | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Fields)
		: null;
}

function bounded(value: unknown, limit: number): string | undefined {
	return typeof value === 'string' && value ? value.slice(0, limit) : undefined;
}

/* The first JSON object that starts a line. Run through the workspace's own
   package scripts, the CLI's standard output can carry the package manager's
   lines around the envelope (a failed nested run reports itself after it). */
function envelopeIn(stdout: string): Fields | null {
	const start = stdout.search(/^\{/m);
	if (start < 0) return null;
	let depth = 0;
	let quoted = false;
	for (let index = start; index < stdout.length; index += 1) {
		const ch = stdout[index];
		if (quoted) {
			if (ch === '\\') index += 1;
			else if (ch === '"') quoted = false;
		} else if (ch === '"') quoted = true;
		else if (ch === '{') depth += 1;
		else if (ch === '}' && --depth === 0) {
			try {
				return fields(JSON.parse(stdout.slice(start, index + 1)));
			} catch {
				return null;
			}
		}
	}
	return null;
}

/* A failed validator prints the CLI envelope with a report for every
   specification or manifest the workspace holds, the read-only reference
   copies included, most of them valid with warnings. What failed is the
   error issues of the reports marked invalid; an envelope whose reports all
   passed failed as a whole, and its own error says why. */
export function validatorIssues(
	stdout: string,
): Pick<GateResult, 'issues' | 'moreIssues'> | null {
	const envelope = envelopeIn(stdout);
	const error = fields(envelope?.error);
	if (envelope?.ok !== false || !error) return null;
	const reports = fields(error.details)?.reports;
	const issues: GateIssue[] = [];
	let more = 0;
	for (const report of Array.isArray(reports) ? reports : []) {
		const entry = fields(report);
		if (entry?.valid !== false || !Array.isArray(entry.issues)) continue;
		const file = bounded(entry.file, 300);
		for (const candidate of entry.issues) {
			const issue = fields(candidate);
			const code = bounded(issue?.code, 80);
			const message = bounded(issue?.message, 500);
			if (issue?.severity !== 'error' || !code || !message) continue;
			if (issues.length >= MAX_GATE_ISSUES) {
				more += 1;
				continue;
			}
			const path = bounded(issue.path, 300);
			issues.push({
				...(file ? { file } : {}),
				code,
				...(path ? { path } : {}),
				message,
			});
		}
	}
	if (issues.length > 0)
		return { issues, ...(more > 0 ? { moreIssues: more } : {}) };
	const code = bounded(error.code, 80);
	const message = bounded(error.message, 500);
	return code && message ? { issues: [{ code, message }] } : null;
}

/* Standard output up to `stdoutLimit` characters is also kept apart from
   the bounded, interleaved output; past the limit it is dropped as a whole. */
function runProcess(
	command: string,
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal | undefined,
	stdoutLimit = 0,
): Promise<{ code: number | null; output: string; stdout: string | null }> {
	return new Promise((resolvePromise) => {
		if (signal?.aborted) {
			resolvePromise({
				code: null,
				output: 'The gate was stopped.',
				stdout: null,
			});
			return;
		}
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
		let stdout: string | null = stdoutLimit > 0 ? '' : null;
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			append(chunk);
			if (stdout !== null)
				stdout =
					stdout.length + chunk.length > stdoutLimit ? null : stdout + chunk;
		});
		child.stderr.on('data', append);
		const timer = setTimeout(() => {
			append('\nThe gate exceeded its time budget and was stopped.');
			child.kill('SIGKILL');
		}, GATE_TIMEOUT_MS);
		timer.unref();
		const stop = () => {
			append('\nThe turn was stopped, so the gate was stopped with it.');
			child.kill('SIGKILL');
		};
		signal?.addEventListener('abort', stop, { once: true });
		const settle = (value: {
			code: number | null;
			output: string;
			stdout: string | null;
		}) => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', stop);
			resolvePromise(value);
		};
		child.on('error', (error) => {
			settle({ code: null, output: `${output()}\n${error.message}`, stdout });
		});
		child.on('close', (code) => {
			settle({ code, output: output(), stdout });
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
			...(!result.passed && result.issues?.length
				? { issues: result.issues }
				: {}),
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
		context.signal,
		definition.envelope ? ENVELOPE_LIMIT : 0,
	);
	const reported =
		result.code !== 0 && result.stdout !== null
			? validatorIssues(result.stdout)
			: null;
	return {
		id,
		...module,
		status: result.code === 0 ? 'passed' : 'failed',
		durationMs: Date.now() - startedAt,
		command: printable,
		output: result.output.trim(),
		...reported,
	};
}

export interface RunGatesInput {
	readonly workspaceRoot: string;
	readonly paths: SessionPaths;
	readonly session: SandboxSession;
	readonly gates: readonly GateId[];
	/* The draft modules to gate; every module of the session by default. A turn
	   passes the ones that changed, so an untouched module is not re-checked. */
	readonly modules?: readonly SessionModule[];
	/* Stopping a turn must stop its gates. Without this a spawned gate outlives
	   the abort and the session stays busy until the gate's own budget expires. */
	readonly signal?: AbortSignal | undefined;
}

/* Workspace gates run once; module gates run once per draft module, so a
   session that touches several modules reports each of them. */
export async function runGates(
	input: RunGatesInput,
): Promise<readonly GateResult[]> {
	const results: GateResult[] = [];
	const modules = input.modules ?? input.session.modules;
	for (const id of input.gates) {
		const definition = GATE_DEFINITIONS.find((gate) => gate.id === id)!;
		const targets =
			definition.scope === 'workspace' ? modules.slice(0, 1) : modules;
		for (const module of targets) {
			/* A stopped turn runs no further gates. The one already spawned is
			   killed through the same signal. */
			if (input.signal?.aborted) return results;
			const context: GateContext = {
				workspaceRoot: input.workspaceRoot,
				paths: input.paths,
				session: input.session,
				module,
				modulePath: modulePathOf(input.paths, module.directory),
				signal: input.signal,
			};
			const result = await runGate(definition, context);
			const refusal = await definition.refuse?.(context);
			results.push(
				refusal
					? {
							...result,
							status: 'failed',
							output: [`${refusal.code}: ${refusal.message}`, result.output]
								.filter(Boolean)
								.join('\n\n'),
							issues: [
								{
									code: refusal.code,
									message: refusal.message.slice(0, 2_000),
								},
								...(result.issues ?? []),
							],
						}
					: result,
			);
		}
	}
	return results;
}
