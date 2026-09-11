import { renderBrandHeader } from '@flowdular/dev-console/brand';
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
	if (
		process.stdout.isTTY &&
		!arguments_.flags.has('json') &&
		(interactive ||
			arguments_.positionals.length === 0 ||
			arguments_.positionals[0] === 'help' ||
			arguments_.flags.has('help'))
	) {
		process.stdout.write(
			'\n' +
				renderBrandHeader({
					subtitle: interactive ? 'Application setup' : 'Application toolkit',
					color: Boolean(
						process.stdout.hasColors?.() &&
							!('NO_COLOR' in process.env) &&
							!process.env.CI,
					),
				}) +
				'\n\n',
		);
	}
	const envelope = await (interactive
		? runSetupWizard(arguments_)
		: runProgram(arguments_));
	process.stdout.write(
		`${renderOutput(envelope, arguments_.flags.has('json'), Boolean(process.stdout.isTTY && process.stdout.hasColors?.() && !('NO_COLOR' in process.env) && !process.env.CI))}\n`,
	);
	if (!envelope.ok) process.exitCode = 1;
}
