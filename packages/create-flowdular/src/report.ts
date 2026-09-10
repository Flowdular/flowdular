import type { PackageManager } from './args.ts';
import { styleText } from 'node:util';

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
		runScript(input.packageManager, 'flowdular', 'setup'),
		runScript(input.packageManager, 'dev'),
	];
}

export function renderNextSteps(input: NextStepsInput, color = false): string {
	const paint = (text: string, format: 'bold' | 'cyan' | 'green' | 'dim') =>
		color ? styleText(format, text, { validateStream: false }) : text;
	const labels = [
		'Open your project',
		...(input.installed ? [] : ['Install dependencies']),
		'Choose local demo or PostgreSQL',
		'Start your app',
	];
	return [
		'',
		`  ${paint('FLOWDULAR', 'bold')}  ${paint('Project created', 'green')}`,
		'',
		...nextSteps(input).flatMap((step, index) => [
			`  ${paint(`${index + 1}.`, 'cyan')} ${labels[index]}`,
			`     ${paint(step, 'bold')}`,
			'',
		]),
		`  ${paint('Local URL', 'dim')}   ${paint(DEV_URL, 'cyan')}`,
		`  ${paint('Demo login', 'dim')}  admin@example.com`,
		`  ${paint('Demo account is created only with local demo setup.', 'dim')}`,
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
