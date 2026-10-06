import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArguments } from '../src/arguments.ts';
import { renderOutput } from '../src/output.ts';
import { runCommand } from '../src/runner.ts';

let workspace: string;
const environment = { ...process.env };
const SECRET = 'sk-probe-7f3a9c';
const kernel = (file: string) =>
	fileURLToPath(new URL(`../../kernel/src/${file}`, import.meta.url));

const COMMANDS = [
	'refuse',
	'malformed',
	'fail',
	'runtime',
	'aborted',
	'read',
	'legacy',
	'keyring',
	'variable',
] as const;

const CATALOG = {
	protocolVersion: 1,
	moduleId: 'probe.core',
	commands: COMMANDS.map((name) => ({
		path: ['probe', name],
		capability: {
			id: `probe.${name}`,
			version: 1,
			summary: `Probe ${name}.`,
			risk: 'read',
			requiresApprovedSpec: false,
			supportsDryRun: false,
		},
	})),
};

/* A module throws its own service error class, which the runner cannot
   import. The kernel commands load the kernel files the runner loads, as a
   module in this repository does. */
const ENTRY = `import { flowdularLocalDataPath } from ${JSON.stringify(kernel('legacy-local-state.ts'))};
import { KeyringError } from ${JSON.stringify(kernel('keyring.ts'))};
import { VariableResolutionError } from ${JSON.stringify(kernel('variable-registry.ts'))};

const capabilities = ${JSON.stringify(
	Object.fromEntries(
		CATALOG.commands.map((command) => [
			command.capability.id,
			command.capability,
		]),
	),
)};

class ProbeServiceError extends Error {
	constructor(code, message, status, options) {
		super(message, options);
		this.name = 'ProbeServiceError';
		this.code = code;
		this.status = status;
		this.token = ${JSON.stringify(SECRET)};
	}
}

const handlers = {
	refuse: () => {
		throw new ProbeServiceError(
			'WORKSPACE_NOT_FOUND',
			'No workspace matches "nowhere".',
			404,
			{ cause: new Error(${JSON.stringify(SECRET)}) },
		);
	},
	malformed: () => {
		throw new ProbeServiceError(
			'token=' + ${JSON.stringify(SECRET)},
			'The probe refused.',
			400,
		);
	},
	fail: () => {
		throw new Error('the probe command refused.', {
			cause: new Error(${JSON.stringify(SECRET)}),
		});
	},
	runtime: () => ({ data: new URL('not a url') }),
	aborted: async (context) => {
		await context.databases.acquire({
			namespace: 'probe.core',
			purpose: 'runtime',
			signal: AbortSignal.abort(new Error(${JSON.stringify(SECRET)})),
		});
		return { data: {} };
	},
	read: async (context) => {
		const lease = await context.databases.acquire({
			namespace: 'probe.core',
			purpose: 'migration',
		});
		try {
			await lease.database.query({ text: 'SELECT 1' });
		} finally {
			await lease.release();
		}
		return { data: {} };
	},
	legacy: (context) => ({
		data: flowdularLocalDataPath(context.workspaceRoot, 'probe.key'),
	}),
	keyring: () => {
		throw new KeyringError('ENVELOPE_INVALID', 'The envelope does not open.');
	},
	variable: () => {
		throw new VariableResolutionError(
			'UNKNOWN_TEMPLATE_VARIABLE',
			'The template names an unknown variable.',
		);
	},
};

export default Object.freeze({
	protocolVersion: 1,
	moduleId: 'probe.core',
	commands: Object.entries(handlers).map(([name, execute]) => ({
		path: ['probe', name],
		capability: capabilities['probe.' + name],
		execute,
	})),
});
`;

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'flowdular-command-errors-'));
	const moduleRoot = join(workspace, 'modules/probe');
	await mkdir(join(moduleRoot, 'src/cli'), { recursive: true });
	await Promise.all([
		writeFile(
			join(workspace, 'flowdular.json'),
			'{"modules":{"enabled":["probe.core"]}}\n',
		),
		writeFile(
			join(moduleRoot, 'module.json'),
			`${JSON.stringify({
				schemaVersion: 1,
				id: 'probe.core',
				package: '@flowdular/module-probe',
				version: '0.1.0',
				profile: 'full',
				capabilities: ['cli'],
				dependencies: [],
				tenancy: 'required',
				locales: ['en'],
				stability: 'experimental',
				cli: { catalog: 'src/cli/commands.json', entry: 'src/cli/index.ts' },
			})}\n`,
		),
		writeFile(
			join(moduleRoot, 'src/cli/commands.json'),
			`${JSON.stringify(CATALOG)}\n`,
		),
		writeFile(join(moduleRoot, 'src/cli/index.ts'), ENTRY),
	]);
	process.env.NODE_ENV = 'development';
	process.env.FD_DATABASE_ADAPTER = 'pglite';
	process.env.FD_DATABASE_PGLITE_DIRECTORY = join(workspace, 'pglite');
	delete process.env.FD_DATABASE_URL;
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) {
		if (!(key in environment)) delete process.env[key];
	}
	Object.assign(process.env, environment);
});

async function run(command: (typeof COMMANDS)[number]) {
	return runCommand(parseArguments(['--root', workspace, 'probe', command]));
}

describe('the error code of a failed command', () => {
	it('keeps a module refusal code in the JSON and the human output', async () => {
		const envelope = await run('refuse');

		expect(JSON.parse(renderOutput(envelope, true))).toMatchObject({
			ok: false,
			error: {
				code: 'WORKSPACE_NOT_FOUND',
				message: 'No workspace matches "nowhere".',
			},
		});
		expect(renderOutput(envelope, false)).toBe(
			'ERROR WORKSPACE_NOT_FOUND\nNo workspace matches "nowhere".',
		);
	});

	it('keeps the code of a database contract error', async () => {
		const envelope = await run('aborted');

		expect(envelope.error).toEqual({
			code: 'OPERATION_ABORTED',
			message: 'Database operation was aborted.',
		});
	});

	/* What an operator meets when a command opens the embedded database that a
	   running pnpm dev holds. The parent process stands in for that server. */
	it('keeps the code of a locked local database', async () => {
		const directory = join(workspace, 'pglite');
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, 'flowdular.lock'),
			`${process.ppid}\n${new Date().toISOString()}\n`,
		);

		const envelope = await run('read');

		expect(envelope.error?.code).toBe('LOCAL_DATABASE_LOCKED');
		expect(renderOutput(envelope, false)).toMatch(
			/^ERROR LOCAL_DATABASE_LOCKED\nThe local database in .* is already open/,
		);
	});

	it('keeps the code of a local state path the runner refuses', async () => {
		delete process.env.FD_DATABASE_PGLITE_DIRECTORY;
		await writeFile(join(workspace, '.flowdular'), 'not a directory\n');

		const envelope = await run('read');

		expect(envelope.error?.code).toBe('UNSAFE_LOCAL_STATE_PATH');
	});

	it('keeps the code of a platform error a module command raises', async () => {
		await mkdir(join(workspace, '.octane-erp'));
		await writeFile(join(workspace, '.octane-erp/probe.key'), 'legacy\n');

		const envelope = await run('legacy');

		expect(envelope.error?.code).toBe('LEGACY_LOCAL_STATE_REQUIRES_MIGRATION');
		expect(renderOutput(envelope, false)).toMatch(
			/^ERROR LEGACY_LOCAL_STATE_REQUIRES_MIGRATION\nLegacy local state exists for probe\.key\./,
		);
	});

	it.each([
		['keyring', 'ENVELOPE_INVALID'],
		['variable', 'UNKNOWN_TEMPLATE_VARIABLE'],
	] as const)(
		'keeps the kernel code of the %s command',
		async (command, code) => {
			const envelope = await run(command);

			expect(envelope.error?.code).toBe(code);
		},
	);

	it.each([
		['an error without a code', 'fail', 'the probe command refused.'],
		['a Node.js error', 'runtime', 'Invalid URL'],
		['a code outside the stable form', 'malformed', 'The probe refused.'],
	] as const)(
		'reports %s as COMMAND_FAILED',
		async (_label, command, message) => {
			const envelope = await run(command);

			expect(envelope.error).toEqual({ code: 'COMMAND_FAILED', message });
			expect(renderOutput(envelope, false)).toBe(
				`ERROR COMMAND_FAILED\n${message}`,
			);
		},
	);

	it.each(['refuse', 'malformed', 'fail', 'runtime', 'aborted'] as const)(
		'prints no stack, cause or error field for %s',
		async (command) => {
			const envelope = await run(command);

			for (const output of [
				renderOutput(envelope, true),
				renderOutput(envelope, false),
			]) {
				expect(output).not.toContain(SECRET);
				expect(output).not.toMatch(/\n\s+at |stack|cause/);
			}
			expect(Object.keys(envelope.error ?? {})).toEqual(['code', 'message']);
		},
	);
});
