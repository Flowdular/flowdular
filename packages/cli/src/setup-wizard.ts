import { stat } from 'node:fs/promises';
import { databaseProviderConfigFromEnvironment } from '@flowdular/database';
import {
	failure,
	success,
	type CommandEnvelope,
} from '@flowdular/cli-protocol';
import { type ParsedArguments, stringFlag } from './arguments.ts';
import { runProgram } from './program.ts';
import { findWorkspace } from './workspace.ts';
import {
	readSetupEnvironment,
	saveSetupEnvironment,
} from './setup-environment.ts';

type SetupChoice = 'local' | 'postgresql' | 'check';
export interface SetupPrompts {
	choose(): Promise<SetupChoice>;
	confirm(message: string): Promise<boolean>;
	connection(message: string): Promise<string>;
}
const prompts: SetupPrompts = {
	async choose() {
		const { select } = await import('@inquirer/prompts');
		return select({
			message: 'How would you like to set up this application?',
			choices: [
				{
					name: 'Local demo with embedded PostgreSQL (PGlite)',
					value: 'local',
				},
				{
					name: 'Configure an existing PostgreSQL database',
					value: 'postgresql',
				},
				{ name: 'Check configuration only', value: 'check' },
			],
		});
	},
	async confirm(message) {
		const { confirm } = await import('@inquirer/prompts');
		return confirm({ message, default: false });
	},
	async connection(message) {
		const { password } = await import('@inquirer/prompts');
		return password({
			message,
			mask: '*',
			validate: (value) =>
				validConnection(value)
					? true
					: 'Use postgres://user:password@host/database without SSL query parameters.',
		});
	},
};
export function validConnection(value: string): boolean {
	if (value.length > 4096 || /[\r\n'\0]/.test(value)) return false;
	try {
		const url = new URL(value);
		return (
			['postgres:', 'postgresql:'].includes(url.protocol) &&
			Boolean(url.hostname && url.username && url.pathname.length > 1) &&
			!['sslmode', 'sslcert', 'sslkey', 'sslrootcert'].some((key) =>
				url.searchParams.has(key),
			)
		);
	} catch {
		return false;
	}
}

export async function runSetupWizard(
	arguments_: ParsedArguments,
	io: SetupPrompts = prompts,
	execute: (args: ParsedArguments) => Promise<CommandEnvelope> = runProgram,
): Promise<CommandEnvelope> {
	try {
		const flags = new Map(arguments_.flags);
		flags.delete('apply');
		flags.delete('confirm');
		const check = await execute({ positionals: ['setup', 'check'], flags });
		if (!check.ok) return check;
		const workspace = await findWorkspace(
			stringFlag(arguments_, 'root') ?? process.cwd(),
		);
		const before = await readSetupEnvironment(workspace.root);
		const choice = await io.choose();
		if (choice === 'check') return check;
		if (choice === 'postgresql') {
			const urls = {
				FD_DATABASE_URL: await io.connection('Runtime role connection URL'),
				FD_DATABASE_MIGRATOR_URL: await io.connection(
					'Migration role connection URL',
				),
				FD_DATABASE_BACKGROUND_URL: await io.connection(
					'Background role connection URL',
				),
			};
			if (!Object.values(urls).every(validConnection))
				return failure(
					'INVALID_DATABASE_CONFIGURATION',
					'Invalid PostgreSQL connection settings.',
				);
			const updates = {
				...urls,
				FD_DATABASE_ADAPTER: 'postgresql',
				FD_DATABASE_TLS: 'verify-full',
			};
			databaseProviderConfigFromEnvironment(
				{ ...process.env, ...updates, NODE_ENV: 'production' },
				workspace.root,
			);
			if (
				!(await io.confirm(
					'Save PostgreSQL settings in .env? This does not reset or modify the hosted database.',
				))
			)
				return success({ cancelled: true });
			await saveSetupEnvironment(workspace.root, before, updates);
			return success(
				{
					setup: 'postgresql',
					configured: true,
					adapter: 'postgresql',
					next: 'Run pnpm dev, then open http://localhost:4310 and create an account.',
				},
				{
					warnings: [
						'TLS certificate verification is enabled. The database must provide separate migration, runtime and background roles.',
					],
				},
			);
		}
		const config = databaseProviderConfigFromEnvironment(
			process.env,
			workspace.root,
		);
		if (
			config.adapter !== 'pglite' ||
			process.env.FD_DATABASE_PGLITE_DIRECTORY ||
			process.env.CORELOOM_DATABASE_PGLITE_DIRECTORY ||
			process.env.FD_DATABASE_URL ||
			process.env.CORELOOM_DATABASE_URL
		)
			return failure(
				'LOCAL_DEMO_UNAVAILABLE',
				'Local demo setup requires the default embedded database. The configured database will not be reset.',
			);
		const preview = await execute({ positionals: ['setup', 'quick'], flags });
		if (!preview.ok) return preview;
		const directory = config.pglite?.dataDirectory;
		let existing = false;
		if (directory)
			try {
				await stat(directory);
				existing = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		const message = existing
			? `Reset the local demo database in ${directory}? All existing local data will be deleted. Confirm that the app is stopped.`
			: 'Create a local demo with admin@example.com? Confirm that the app is stopped.';
		if (!(await io.confirm(message))) return success({ cancelled: true });
		if ((await readSetupEnvironment(workspace.root)) !== before)
			return failure(
				'SETUP_CONFIGURATION_CHANGED',
				'The .env file changed during setup. Run setup again.',
			);
		flags.set('apply', true);
		flags.set('confirm', 'reset-local-auth');
		const applied = await execute({ positionals: ['setup', 'quick'], flags });
		return applied.ok
			? success(
					{ ...(applied.data as Record<string, unknown>), setup: 'local' },
					{ warnings: applied.warnings, evidence: applied.evidence },
				)
			: applied;
	} catch (error) {
		if (
			error instanceof Error &&
			['ExitPromptError', 'AbortPromptError'].includes(error.name)
		)
			return success({ cancelled: true });
		return failure(
			'SETUP_FAILED',
			error instanceof Error ? error.message : 'Setup failed.',
		);
	}
}
