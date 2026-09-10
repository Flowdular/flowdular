import { parseArguments } from './arguments.ts';
import { renderOutput } from './output.ts';
import { runCommand } from './runner.ts';
import { runProgram } from './program.ts';
import { runSetupWizard } from './setup-wizard.ts';

export { parseArguments, runCommand };

const invokedAsProgram =
	process.argv[1]?.endsWith('/index.ts') ||
	process.argv[1]?.endsWith('/index.js');

if (invokedAsProgram) {
	const arguments_ = parseArguments(process.argv.slice(2));
	const interactive =
		arguments_.positionals.length === 1 &&
		arguments_.positionals[0] === 'setup' &&
		!arguments_.flags.has('json') &&
		!arguments_.flags.has('help') &&
		process.stdin.isTTY &&
		process.stdout.isTTY;
	const envelope = await (interactive
		? runSetupWizard(arguments_)
		: runProgram(arguments_));
	process.stdout.write(
		`${renderOutput(envelope, arguments_.flags.has('json'))}\n`,
	);
	if (!envelope.ok) process.exitCode = 1;
}
