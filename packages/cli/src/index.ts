import { parseArguments } from './arguments.ts';
import { renderOutput } from './output.ts';
import { runCommand } from './runner.ts';
import { runProgram } from './program.ts';

export { parseArguments, runCommand };

const invokedAsProgram =
	process.argv[1]?.endsWith('/index.ts') ||
	process.argv[1]?.endsWith('/index.js');

if (invokedAsProgram) {
	const arguments_ = parseArguments(process.argv.slice(2));
	const envelope = await runProgram(arguments_);
	process.stdout.write(
		`${renderOutput(envelope, arguments_.flags.has('json'))}\n`,
	);
	if (!envelope.ok) process.exitCode = 1;
}
