import { flowdularEnvironment } from '@flowdular/kernel/runtime-config';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { failure, type CommandEnvelope } from '@flowdular/cli-protocol';
import { stringFlag, type ParsedArguments } from './arguments.ts';
import { runCommand } from './runner.ts';
import { findWorkspace } from './workspace.ts';

/** Only the executable owns process.env. Programmatic runCommand callers supply their own environment. */
export async function runProgram(
	arguments_: ParsedArguments,
): Promise<CommandEnvelope> {
	try {
		const workspace = await findWorkspace(
			stringFlag(arguments_, 'root') ?? process.cwd(),
		);
		try {
			loadEnvFile(resolve(workspace.root, '.env'));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
				return failure(
					'ENVIRONMENT_FILE_UNREADABLE',
					'The workspace .env file could not be read. Refusing to select a fallback database.',
				);
		}
		Object.assign(process.env, flowdularEnvironment(process.env));
		return await runCommand(arguments_);
	} catch (error) {
		return failure(
			'COMMAND_FAILED',
			error instanceof Error ? error.message : String(error),
		);
	}
}
