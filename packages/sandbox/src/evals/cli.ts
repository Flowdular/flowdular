/* The evaluation suite's entry point. Launched through scripts/eval.mjs, which
   runs it under the workspace TypeScript runner: the server graph this reaches
   spans several workspace packages, and Node's own strip-only mode refuses the
   syntax some of them use. */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { createSandboxRuntime } from '../server/runtime.ts';
import { hashSpec } from '../server/spec.ts';
import { approvalState, loadCases, type EvalCase } from './cases.ts';
import { runSuite, type EvalSuiteReport } from './run.ts';

interface Options {
	suite: string;
	workspace: string;
	case: string | null;
	driver: string | null;
	model: string | null;
	approve: string | null;
	confirm: string | null;
	apply: boolean;
	json: boolean;
	help: boolean;
}

const USAGE = `flowdular eval [options]

  --case <id>        Run one case instead of the whole suite
  --driver <id>      Coding agent driver; defaults to the workspace setting
  --model <id>       Model override for the driver
  --suite <path>     Suite root; defaults to <workspace>/evals
  --workspace <path> Workspace root; defaults to the working directory
  --json             Write the report as JSON on stdout
  --approve <id>     Record your approval of that case's specification
  --apply --confirm approve-<id>
                     Required with --approve. The approval is yours, not the
                     runner's, so it cannot happen by accident.
`;

export function parseArguments(argv: readonly string[]): Options {
	const options: Options = {
		suite: '',
		workspace: process.cwd(),
		case: null,
		driver: null,
		model: null,
		approve: null,
		confirm: null,
		apply: false,
		json: false,
		help: false,
	};
	const valued = new Set([
		'suite',
		'workspace',
		'case',
		'driver',
		'model',
		'approve',
		'confirm',
	]);
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]!;
		if (argument === '--help' || argument === '-h') options.help = true;
		else if (argument === '--apply') options.apply = true;
		else if (argument === '--json') options.json = true;
		else {
			const named = /^--([a-z]+)(?:=(.*))?$/.exec(argument);
			if (!named || !valued.has(named[1]!)) continue;
			const value = named[2] ?? argv[++index] ?? null;
			(options as unknown as Record<string, string | null>)[named[1]!] = value;
		}
	}
	options.workspace = resolve(options.workspace);
	options.suite = options.suite
		? resolve(options.suite)
		: join(options.workspace, 'evals');
	return options;
}

export function report(suite: EvalSuiteReport): string {
	const lines: string[] = [''];
	for (const result of suite.cases) {
		const mark =
			result.status === 'passed'
				? 'PASS'
				: result.status === 'failed'
					? 'FAIL'
					: 'SKIP';
		lines.push(
			`${mark}  ${result.caseId}  ${result.turns} turns  ${Math.round(result.durationMs / 1000)}s`,
		);
		if (result.refusal) lines.push(`      ${result.refusal}`);
		for (const gate of result.gates.filter(
			(entry) => entry.status !== 'passed',
		))
			lines.push(`      gate ${gate.id}: ${gate.status}`);
		for (const check of result.checks.filter((entry) => !entry.passed))
			lines.push(`      check ${check.id}: ${check.detail}`);
	}
	lines.push(
		'',
		`${suite.passed} passed, ${suite.failed} failed, ${suite.refused} refused.`,
	);
	return lines.join('\n');
}

async function approve(
	options: Options,
	cases: readonly EvalCase[],
): Promise<number> {
	const evaluation = cases.find((entry) => entry.id === options.approve);
	if (!evaluation) {
		console.error(`No case named ${options.approve}.`);
		return 1;
	}
	const expected = `approve-${evaluation.id}`;
	if (!options.apply || options.confirm !== expected) {
		console.log(evaluation.spec);
		console.error(
			`\nRead the specification above. To approve it, run again with --apply --confirm ${expected}.`,
		);
		return 1;
	}
	const manifestPath = join(evaluation.root, 'case.json');
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
		string,
		unknown
	>;
	const specHash = hashSpec(evaluation.spec);
	manifest.approval = {
		specHash,
		approvedBy: process.env.USER ?? 'operator',
		approvedAt: new Date().toISOString().slice(0, 10),
	};
	await writeFile(
		manifestPath,
		`${JSON.stringify(manifest, null, '\t')}\n`,
		'utf8',
	);
	console.log(
		`Approved ${evaluation.id} at ${specHash.slice(0, 12)}. Editing the specification invalidates it.`,
	);
	return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
	const options = parseArguments(argv);
	if (options.help) {
		console.log(USAGE);
		return 0;
	}
	const cases = await loadCases(options.suite);
	if (options.approve) return approve(options, cases);

	const selected = options.case
		? cases.filter((entry) => entry.id === options.case)
		: cases;
	if (selected.length === 0) {
		console.error(`No case named ${options.case}.`);
		return 1;
	}
	if (selected.every((entry) => approvalState(entry) !== 'approved')) {
		console.error(
			'Every selected case is unapproved. Approve one with --approve <id> before running the suite.',
		);
		return 1;
	}

	const runtime = await createSandboxRuntime(options.workspace);
	const suite = await runSuite(
		{
			context: {
				workspaceRoot: options.workspace,
				configuration: runtime.configuration(),
				registry: runtime.registry(),
				roles: runtime.roles(),
				platform: runtime.platform(),
			},
			driver: options.driver ?? runtime.configuration().driver,
			model: options.model,
			...(options.json
				? {}
				: { onEvent: (message: string) => console.log(message) }),
		},
		selected,
	);
	console.log(options.json ? JSON.stringify(suite, null, '\t') : report(suite));
	return suite.failed > 0 ? 1 : 0;
}

/* tsx runs this file as the process entry; the guard keeps the module
   importable by the tests without launching a suite. */
if (process.argv[1] && process.argv[1].endsWith('cli.ts'))
	process.exit(await main(process.argv.slice(2)));
