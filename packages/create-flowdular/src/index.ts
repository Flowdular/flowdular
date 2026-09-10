import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { ArgumentError, parseArguments } from './args.ts';
import { initializeRepository } from './git.ts';
import { detectPackageManager, installDependencies } from './pm.ts';
import { HELP, renderNextSteps } from './report.ts';
import { scaffold, ScaffoldError } from './scaffold.ts';
import { TemplateError } from './template.ts';

export { parseArguments, ArgumentError } from './args.ts';
export { scaffold, ScaffoldError } from './scaffold.ts';
export { checkProjectName, checkTargetPath } from './name.ts';
export {
	generateSecrets,
	renderEnvironmentFile,
	SECRET_KEYS,
} from './secrets.ts';

export interface RunIo {
	readonly color?: boolean;
	readonly cwd: string;
	readonly out: (text: string) => void;
	readonly err: (text: string) => void;
}

const processIo: RunIo = {
	color: Boolean(
		process.stdout.isTTY &&
			process.stdout.hasColors?.() &&
			!('NO_COLOR' in process.env) &&
			!process.env.CI,
	),
	cwd: process.cwd(),
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
};

async function packageVersion(): Promise<string> {
	const manifest = JSON.parse(
		await readFile(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
	) as { version?: string };
	return manifest.version ?? '0.0.0';
}

export async function run(
	argv: readonly string[],
	io: RunIo = processIo,
): Promise<number> {
	let options;
	try {
		options = parseArguments(argv);
	} catch (error) {
		if (!(error instanceof ArgumentError)) throw error;
		io.err(`ERROR ${error.message}\n`);
		return 1;
	}
	if (options.help) {
		io.out(HELP);
		return 0;
	}
	if (options.version) {
		io.out(`${await packageVersion()}\n`);
		return 0;
	}

	const packageManager =
		options.packageManager ??
		detectPackageManager(process.env.npm_config_user_agent);
	if (packageManager !== 'pnpm') {
		io.err(
			'ERROR This template uses pnpm workspaces. Run npm create flowdular@latest my-app without --pm, or choose --pm pnpm.\n',
		);
		return 1;
	}
	let result;
	try {
		result = await scaffold({
			cwd: io.cwd,
			target: options.target,
			template: options.template,
			force: options.force,
		});
	} catch (error) {
		if (
			!(error instanceof ScaffoldError) &&
			!(error instanceof TemplateError)
		) {
			throw error;
		}
		io.err(`ERROR ${error.message}\n`);
		return 1;
	}

	io.out(
		`Created ${result.name} in ${result.directory} (${String(result.files)} files).\n`,
	);

	let installed = false;
	if (options.install) {
		io.out(`Installing dependencies with ${packageManager}.\n`);
		const install = installDependencies(packageManager, result.directory);
		installed = install.ok;
		if (!install.ok) io.err(`WARNING ${install.reason}.\n`);
	}
	if (options.git) {
		const git = initializeRepository(result.directory);
		if (!git.ok) io.err(`WARNING ${git.reason}.\n`);
	}

	const here = relative(io.cwd, result.directory);
	io.out(
		renderNextSteps(
			{
				directory: here.length > 0 ? here : '.',
				packageManager,
				installed,
			},
			io.color,
		),
	);
	return 0;
}
