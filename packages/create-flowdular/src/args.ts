import { checkTargetPath } from './name.ts';

export const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export interface Options {
	readonly target: string;
	readonly template: string;
	readonly packageManager?: PackageManager;
	readonly install: boolean;
	readonly git: boolean;
	readonly force: boolean;
	readonly help: boolean;
	readonly version: boolean;
}

export class ArgumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ArgumentError';
	}
}

function isPackageManager(value: string): value is PackageManager {
	return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

function valueOf(
	flag: string,
	inline: string | undefined,
	next: string | undefined,
): { readonly value: string; readonly consumedNext: boolean } {
	if (inline !== undefined) {
		if (inline.length === 0) throw new ArgumentError(`${flag} needs a value.`);
		return { value: inline, consumedNext: false };
	}
	if (next === undefined || next.startsWith('-')) {
		throw new ArgumentError(`${flag} needs a value.`);
	}
	return { value: next, consumedNext: true };
}

export function parseArguments(argv: readonly string[]): Options {
	let target: string | undefined;
	let template = 'default';
	let packageManager: PackageManager | undefined;
	let install = true;
	let git = true;
	let force = false;
	let help = false;
	let version = false;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]!;
		const separator = argument.indexOf('=');
		const flag = separator === -1 ? argument : argument.slice(0, separator);
		const inline = separator === -1 ? undefined : argument.slice(separator + 1);
		switch (flag) {
			case '--help':
			case '-h':
				help = true;
				continue;
			case '--version':
			case '-v':
				version = true;
				continue;
			case '--no-install':
				install = false;
				continue;
			case '--no-git':
				git = false;
				continue;
			case '--force':
			case '-f':
				force = true;
				continue;
			case '--template':
			case '-t': {
				const parsed = valueOf(flag, inline, argv[index + 1]);
				if (!/^[a-z][a-z0-9-]*$/.test(parsed.value)) {
					throw new ArgumentError(
						`"${parsed.value}" is not a template name; use lowercase letters, digits and hyphens.`,
					);
				}
				template = parsed.value;
				if (parsed.consumedNext) index += 1;
				continue;
			}
			case '--pm': {
				const parsed = valueOf(flag, inline, argv[index + 1]);
				if (!isPackageManager(parsed.value)) {
					throw new ArgumentError(
						`--pm must be one of ${PACKAGE_MANAGERS.join(', ')}.`,
					);
				}
				packageManager = parsed.value;
				if (parsed.consumedNext) index += 1;
				continue;
			}
			default:
				break;
		}
		if (argument.startsWith('-')) {
			throw new ArgumentError(`Unknown option "${argument}".`);
		}
		if (target !== undefined) {
			throw new ArgumentError(
				`Unexpected argument "${argument}"; the directory is given once.`,
			);
		}
		target = argument;
	}

	if (help || version) {
		return {
			target: target ?? '',
			template,
			...(packageManager ? { packageManager } : {}),
			install,
			git,
			force,
			help,
			version,
		};
	}
	if (target === undefined) {
		throw new ArgumentError(
			'Name the directory to create, for example: create-flowdular my-app',
		);
	}
	const path = checkTargetPath(target);
	if (!path.valid) {
		throw new ArgumentError(
			`"${target}" is not a usable directory: ${path.reason}.`,
		);
	}
	return {
		target,
		template,
		...(packageManager ? { packageManager } : {}),
		install,
		git,
		force,
		help,
		version,
	};
}
