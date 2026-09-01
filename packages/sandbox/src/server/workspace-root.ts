import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface CoreloomWorkspace {
	readonly root: string;
	readonly configPath: string;
	readonly config: Record<string, unknown>;
}

export class SandboxSetupError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'SandboxSetupError';
	}
}

/* The sandbox is always started from a Coreloom workspace, the same way the
   CLI finds it: walk up until coreloom.json is found. */
export async function findCoreloomWorkspace(
	start: string,
): Promise<CoreloomWorkspace> {
	let directory = resolve(start);
	for (;;) {
		const configPath = resolve(directory, 'coreloom.json');
		try {
			await access(configPath);
			return {
				root: directory,
				configPath,
				config: JSON.parse(await readFile(configPath, 'utf8')) as Record<
					string,
					unknown
				>,
			};
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new SandboxSetupError(
					'WORKSPACE_CONFIG_INVALID',
					`coreloom.json in ${directory} is not valid JSON.`,
				);
			}
		}
		const parent = dirname(directory);
		if (parent === directory) {
			throw new SandboxSetupError(
				'WORKSPACE_NOT_FOUND',
				'No coreloom.json was found in this directory or any parent. Start the sandbox from a Coreloom workspace.',
			);
		}
		directory = parent;
	}
}

export function enabledModules(
	workspace: CoreloomWorkspace,
): readonly string[] {
	const modules = workspace.config.modules as
		| { enabled?: readonly string[] }
		| undefined;
	return modules?.enabled ?? [];
}

export function moduleRootsOf(workspace: CoreloomWorkspace): readonly string[] {
	const modules = workspace.config.modules as
		| { roots?: readonly string[] }
		| undefined;
	return modules?.roots ?? ['modules'];
}
