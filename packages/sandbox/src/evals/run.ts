/* Runs one evaluation case end to end: a session from the frozen specification,
   turns until the agent hands off or the cap is reached, the session gates, and
   the deterministic checks over what was written.

   The suite drives the same session code the dashboard drives. Nothing here is
   a parallel implementation of a turn, because a suite that measured its own
   copy of the runtime would keep passing while the real one regressed. */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { GateResult } from '../server/gates.ts';
import {
	approveSpecification,
	createSession,
	modulePathOf,
	sessionPaths,
	type HandoffPlan,
	type SandboxSession,
} from '../server/sessions.ts';
import {
	runSessionGates,
	runTurn,
	scaffoldFromSpec,
	type TurnContext,
} from '../server/turns.ts';
import { approvalState, type EvalCase } from './cases.ts';
import { runChecks, type CheckOutcome } from './checks.ts';

export interface EvalCaseResult {
	readonly caseId: string;
	readonly title: string;
	readonly status: 'passed' | 'failed' | 'refused';
	/* Why a case never ran. Absent once it did. */
	readonly refusal?: string;
	readonly turns: number;
	readonly handoff: HandoffPlan | null;
	readonly gates: readonly GateResult[];
	readonly checks: readonly CheckOutcome[];
	readonly durationMs: number;
	readonly sessionId: string | null;
}

export interface EvalSuiteReport {
	readonly startedAt: string;
	readonly driver: string;
	readonly model: string | null;
	readonly cases: readonly EvalCaseResult[];
	readonly passed: number;
	readonly failed: number;
	readonly refused: number;
}

export interface RunEvalOptions {
	readonly context: TurnContext;
	readonly driver: string;
	readonly model?: string | null;
	/* Replaces the turn loop in tests, so the suite's own behaviour can be
	   proven without a model call. */
	readonly drive?: (
		evaluation: EvalCase,
		session: SandboxSession,
	) => Promise<{ turns: number; handoff: HandoffPlan | null }>;
	readonly onEvent?: (message: string) => void;
}

const TEXT = /\.(ts|tsrx|json|sql|md|css|yaml|yml|txt)$/;

/** Every text file of a module tree, keyed by its path inside the module. */
export async function collectModuleFiles(
	modulePath: string,
): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	const walk = async (directory: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === 'dist') continue;
				await walk(path);
				continue;
			}
			if (!TEXT.test(entry.name)) continue;
			files.set(
				relative(modulePath, path).split('\\').join('/'),
				await readFile(path, 'utf8'),
			);
		}
	};
	await walk(modulePath);
	return files;
}

async function driveTurns(
	options: RunEvalOptions,
	evaluation: EvalCase,
	session: SandboxSession,
): Promise<{ turns: number; handoff: HandoffPlan | null }> {
	let handoff: HandoffPlan | null = null;
	let turns = 0;
	let message = evaluation.brief;
	while (turns < evaluation.maxTurns) {
		const iterator = runTurn(options.context, {
			sessionId: session.id,
			message,
			role: turns === 0 ? evaluation.role : (handoff?.role ?? evaluation.role),
			driver: options.driver,
			module: evaluation.directory,
		});
		let step = await iterator.next();
		while (!step.done) step = await iterator.next();
		turns += 1;
		handoff = step.value.handoff;
		options.onEvent?.(
			`  turn ${turns}: ${handoff.kind} (${handoff.roleName}) ${handoff.reason}`,
		);
		/* Only `continue` is the agent asking for another turn. Every other kind
		   wants a human, and a suite that answered for one would be measuring
		   its own replies. */
		if (handoff.kind !== 'continue') break;
		message = handoff.prompt;
	}
	return { turns, handoff };
}

export async function runEvalCase(
	options: RunEvalOptions,
	evaluation: EvalCase,
): Promise<EvalCaseResult> {
	const started = Date.now();
	const refuse = (refusal: string): EvalCaseResult => ({
		caseId: evaluation.id,
		title: evaluation.title,
		status: 'refused',
		refusal,
		turns: 0,
		handoff: null,
		gates: [],
		checks: [],
		durationMs: Date.now() - started,
		sessionId: null,
	});

	const state = approvalState(evaluation);
	if (state === 'unapproved')
		return refuse(
			`${evaluation.id} carries no approval. Run "pnpm eval:approve ${evaluation.id}" and approve the specification yourself.`,
		);
	if (state === 'stale')
		return refuse(
			`${evaluation.id} was edited after it was approved, so the recorded hash no longer matches. Re-approve it deliberately.`,
		);

	const session = await createSession({
		workspaceRoot: options.context.workspaceRoot,
		kind: evaluation.kind,
		moduleId: evaluation.moduleId,
		title: `eval: ${evaluation.title}`,
		brief: evaluation.brief,
		blueprint: evaluation.blueprint,
		role: evaluation.role,
		driver: options.driver,
		model: options.model ?? null,
		modules: [
			{
				id: evaluation.moduleId,
				directory: evaluation.directory,
				kind: 'new',
			},
		],
		install: true,
	});
	const paths = sessionPaths(
		options.context.workspaceRoot,
		session.id,
		session.moduleSuffix,
	);
	const modulePath = modulePathOf(paths, evaluation.directory);
	await writeFrozenSpec(modulePath, evaluation);
	/* Replaying the operator's own decision on this exact text, checked above.
	   The suite never approves anything the case did not already carry. */
	const approved = await approveSpecification(
		options.context.workspaceRoot,
		session,
		session.modules[0],
	);
	options.onEvent?.(`  session ${session.id} (${approved.status})`);
	await scaffoldFromSpec(options.context, approved.session);

	const driven = await (options.drive
		? options.drive(evaluation, approved.session)
		: driveTurns(options, evaluation, approved.session));

	const gates = await runSessionGates(
		options.context,
		approved.session,
		evaluation.gates,
	);
	const checks = runChecks(evaluation.checks, {
		files: await collectModuleFiles(modulePath),
		spec: evaluation.spec,
	});
	const passed =
		gates.every((gate) => gate.status === 'passed') &&
		checks.every((check) => check.passed);
	return {
		caseId: evaluation.id,
		title: evaluation.title,
		status: passed ? 'passed' : 'failed',
		turns: driven.turns,
		handoff: driven.handoff,
		gates,
		checks,
		durationMs: Date.now() - started,
		sessionId: session.id,
	};
}

async function writeFrozenSpec(
	modulePath: string,
	evaluation: EvalCase,
): Promise<void> {
	const { mkdir, writeFile } = await import('node:fs/promises');
	await mkdir(join(modulePath, 'spec'), { recursive: true });
	await writeFile(
		join(modulePath, 'spec', 'module.yaml'),
		evaluation.spec,
		'utf8',
	);
}

export async function runSuite(
	options: RunEvalOptions,
	cases: readonly EvalCase[],
): Promise<EvalSuiteReport> {
	const results: EvalCaseResult[] = [];
	for (const evaluation of cases) {
		options.onEvent?.(`${evaluation.id}: ${evaluation.title}`);
		results.push(await runEvalCase(options, evaluation));
	}
	return {
		startedAt: new Date().toISOString(),
		driver: options.driver,
		model: options.model ?? null,
		cases: results,
		passed: results.filter((result) => result.status === 'passed').length,
		failed: results.filter((result) => result.status === 'failed').length,
		refused: results.filter((result) => result.status === 'refused').length,
	};
}
