import type { PackageManager } from './args.ts';

export const DEV_URL = 'http://localhost:4310';

/* npm needs "run" and a -- separator for script arguments; pnpm and yarn take
   the script name directly. */
function runScript(
	packageManager: PackageManager,
	script: string,
	...arguments_: string[]
): string {
	if (arguments_.length === 0) {
		return packageManager === 'npm'
			? `npm run ${script}`
			: `${packageManager} ${script}`;
	}
	const tail = arguments_.join(' ');
	return packageManager === 'npm'
		? `npm run ${script} -- ${tail}`
		: `${packageManager} ${script} ${tail}`;
}

export interface NextStepsInput {
	readonly directory: string;
	readonly packageManager: PackageManager;
	readonly installed: boolean;
}

export function nextSteps(input: NextStepsInput): readonly string[] {
	return [
		`cd ${input.directory}`,
		...(input.installed ? [] : [`${input.packageManager} install`]),
		runScript(
			input.packageManager,
			'flowdular',
			'setup',
			'quick',
			'--apply',
			'--confirm',
			'reset-local-auth',
		),
		runScript(input.packageManager, 'dev'),
	];
}

export function renderNextSteps(input: NextStepsInput): string {
	return [
		'',
		'Next:',
		'',
		...nextSteps(input).map((step) => `  ${step}`),
		'',
		`Then open ${DEV_URL} and sign in as admin@example.com.`,
		'',
	].join('\n');
}

export const HELP = `create-flowdular

Scaffold a Flowdular application: the platform, one example module and the
secrets a fresh install needs.

Usage
  npm create flowdular@latest <directory> [options]

Options
  -t, --template <name>   Template to copy (default: default)
      --pm <manager>      Use pnpm for the generated workspace (default: pnpm)
      --no-install        Skip dependency installation
      --no-git            Skip repository initialization
  -f, --force             Scaffold into a directory that is not empty
  -h, --help              Show this help
  -v, --version           Show the version
`;
