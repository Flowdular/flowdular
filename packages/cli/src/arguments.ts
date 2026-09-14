export interface ParsedArguments {
	readonly positionals: readonly string[];
	readonly flags: ReadonlyMap<string, string | boolean>;
}

export function parseArguments(args: readonly string[]): ParsedArguments {
	const positionals: string[] = [];
	const flags = new Map<string, string | boolean>();

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (!argument) continue;
		if (!argument.startsWith('--')) {
			positionals.push(argument);
			continue;
		}

		const separator = argument.indexOf('=');
		if (separator > 2) {
			flags.set(argument.slice(2, separator), argument.slice(separator + 1));
			continue;
		}

		const name = argument.slice(2);
		const next = args[index + 1];
		if (next && !next.startsWith('--')) {
			flags.set(name, next);
			index += 1;
		} else {
			flags.set(name, true);
		}
	}

	return { positionals, flags };
}

export function stringFlag(
	arguments_: ParsedArguments,
	name: string,
): string | undefined {
	const value = arguments_.flags.get(name);
	return typeof value === 'string' ? value : undefined;
}

/** `--grant <token>`: the signed approval grant an external or destructive capability runs under. */
export function grantFlag(arguments_: ParsedArguments): string | undefined {
	const value = stringFlag(arguments_, 'grant');
	return value === undefined || value.length === 0 ? undefined : value;
}
