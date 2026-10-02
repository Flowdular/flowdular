import { createHash } from 'node:crypto';
import {
	access,
	cp,
	readFile,
	readdir,
	realpath,
	writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { SessionModule } from './sessions.ts';
import { runBoundedProcess } from './process-command.ts';
import { parseDocument } from 'yaml';

export interface InstallResult {
	readonly ran: boolean;
	readonly ok: boolean;
	readonly durationMs: number;
	readonly output: string;
}

const OUTPUT_LIMIT = 6_000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const SIGNATURE_FILE = 'install-signature';

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function packageName(directory: string): Promise<string | null> {
	try {
		const manifest = JSON.parse(
			await readFile(join(directory, 'package.json'), 'utf8'),
		) as { name?: string };
		return manifest.name ?? null;
	} catch {
		return null;
	}
}

async function installedCli(
	workspaceRoot: string,
): Promise<{ name: string; version: string; root: string } | null> {
	for (const directory of [
		join(workspaceRoot, 'node_modules/flowdular'),
		join(workspaceRoot, 'platform/node_modules/flowdular'),
		join(workspaceRoot, 'packages/cli'),
	]) {
		try {
			const root = await realpath(directory);
			const manifest = JSON.parse(
				await readFile(join(root, 'package.json'), 'utf8'),
			) as { name?: unknown; version?: unknown; bin?: { flowdular?: unknown } };
			if (
				(manifest.name === 'flowdular' || manifest.name === '@flowdular/cli') &&
				typeof manifest.version === 'string' &&
				typeof manifest.bin?.flowdular === 'string' &&
				(await exists(join(root, manifest.bin.flowdular)))
			) {
				return { name: manifest.name, version: manifest.version, root };
			}
		} catch {
			/* This workspace may not have installed or built its CLI yet. */
		}
	}
	return null;
}

/* A session workspace is a pnpm workspace of its own: the draft modules are its
   projects, every other workspace package is linked to the live checkout, and
   the host lockfile seeds the resolution so the session installs exactly the
   versions the platform runs. A draft that depends on another draft resolves
   the session copy, because both are projects of this workspace. */
export async function materializeSessionWorkspace(options: {
	readonly workspaceRoot: string;
	readonly sessionWorkspace: string;
	readonly modules: readonly SessionModule[];
}): Promise<void> {
	const draft = new Set<string>();
	for (const module of options.modules) {
		const name = await packageName(
			join(options.sessionWorkspace, 'modules', module.directory),
		);
		if (name) draft.add(name);
	}
	const overrides: Record<string, string> = {};
	for (const group of ['packages', 'modules']) {
		let entries: readonly string[] = [];
		try {
			entries = await readdir(join(options.workspaceRoot, group));
		} catch {
			continue;
		}
		for (const entry of [...entries].sort()) {
			const directory = join(options.workspaceRoot, group, entry);
			const name = await packageName(directory);
			if (!name || draft.has(name)) continue;
			overrides[name] = `link:${directory}`;
		}
	}

	// A generated application installs the SDK under platform/. Make that exact
	// SDK discoverable in a new session before its first module is scaffolded.
	let sdkVersion: string | undefined;
	try {
		const require = createRequire(
			join(options.workspaceRoot, 'platform/package.json'),
		);
		const sdkRoot = dirname(require.resolve('@flowdular/sdk/modules.json'));
		const sdk = JSON.parse(
			await readFile(join(sdkRoot, 'package.json'), 'utf8'),
		);
		if (typeof sdk.version !== 'string')
			throw new Error('Invalid installed SDK version.');
		sdkVersion = sdk.version;
		overrides['@flowdular/sdk'] = `link:${sdkRoot}`;
	} catch (error) {
		if (
			!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(
				(error as NodeJS.ErrnoException).code ?? '',
			)
		)
			throw error;
	}
	// Give a fresh session the same CLI binary as its host application. The
	// generated app installs it as flowdular; the source workspace owns the
	// equivalent @flowdular/cli package. Linking avoids registry access.
	const cli = await installedCli(options.workspaceRoot);
	if (cli) overrides[cli.name] = `link:${cli.root}`;
	let host: Record<string, unknown> = {};
	try {
		host = JSON.parse(
			await readFile(join(options.workspaceRoot, 'package.json'), 'utf8'),
		) as Record<string, unknown>;
	} catch {
		host = {};
	}
	await writeFile(
		join(options.sessionWorkspace, 'package.json'),
		`${JSON.stringify(
			{
				name: 'flowdular-session',
				dependencies: {
					...(sdkVersion ? { '@flowdular/sdk': sdkVersion } : {}),
					...(cli ? { [cli.name]: cli.version } : {}),
				},
				private: true,
				type: 'module',
				...(typeof host.packageManager === 'string'
					? { packageManager: host.packageManager }
					: {}),
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);

	/* Build permissions, release-age exclusions and patches travel from the
	   host workspace file; the host lockfile pins the versions. */
	const hostWorkspace = await readFile(
		join(options.workspaceRoot, 'pnpm-workspace.yaml'),
		'utf8',
	).catch(() => '');
	// Edit YAML structurally so lists, custom package globs and host overrides
	// cannot spill into an unrelated setting when a top-level key is replaced.
	const workspaceDocument = parseDocument(hostWorkspace);
	if (workspaceDocument.errors.length > 0) throw workspaceDocument.errors[0];
	workspaceDocument.set('packages', ['modules/*']);
	workspaceDocument.set('allowUnusedPatches', true);
	for (const name of draft) {
		if (workspaceDocument.hasIn(['overrides', name])) {
			workspaceDocument.deleteIn(['overrides', name]);
		}
	}
	for (const [name, target] of Object.entries(overrides)) {
		workspaceDocument.setIn(['overrides', name], target);
	}
	await writeFile(
		join(options.sessionWorkspace, 'pnpm-workspace.yaml'),
		workspaceDocument.toString(),
		'utf8',
	);
	for (const shared of ['pnpm-lock.yaml', 'patches']) {
		const target = join(options.sessionWorkspace, shared);
		if (await exists(target)) continue;
		await cp(join(options.workspaceRoot, shared), target, {
			recursive: true,
		}).catch(() => undefined);
	}
}

async function dependencySignature(
	sessionWorkspace: string,
	modules: readonly SessionModule[],
): Promise<string> {
	const hash = createHash('sha256');
	for (const module of modules) {
		hash.update(module.directory);
		hash.update(
			await readFile(
				join(sessionWorkspace, 'modules', module.directory, 'package.json'),
				'utf8',
			).catch(() => ''),
		);
	}
	return hash.digest('hex');
}

export async function runPnpm(
	cwd: string,
	args: readonly string[],
	options: {
		readonly timeoutMs?: number;
		readonly environment?: NodeJS.ProcessEnv;
	} = {},
): Promise<{ code: number | null; output: string }> {
	const result = await runBoundedProcess('pnpm', args, {
		cwd,
		env: {
			...process.env,
			...options.environment,
			FORCE_COLOR: '0',
		},
		timeoutMs: options.timeoutMs ?? INSTALL_TIMEOUT_MS,
		outputLimit: OUTPUT_LIMIT,
	});
	return {
		code: result.code,
		output: result.timedOut
			? `${result.output}\nThe install exceeded its time budget and was stopped.`.trim()
			: result.output,
	};
}

/* Installs the session workspace when a draft module's package.json changed
   since the last install, or when nothing was installed yet. The store on this
   machine answers first; the registry is consulted only for a package the host
   workspace never fetched. */
export async function ensureSessionDependencies(options: {
	readonly sessionRoot: string;
	readonly sessionWorkspace: string;
	readonly modules: readonly SessionModule[];
	readonly force?: boolean;
	/* A process boundary for deterministic retry tests. */
	readonly runCommand?: typeof runPnpm;
}): Promise<InstallResult> {
	const startedAt = Date.now();
	const signature = await dependencySignature(
		options.sessionWorkspace,
		options.modules,
	);
	const signaturePath = join(options.sessionRoot, SIGNATURE_FILE);
	const previous = await readFile(signaturePath, 'utf8').catch(() => '');
	const installed = await exists(
		join(options.sessionWorkspace, 'node_modules'),
	);
	if (!options.force && installed && previous.trim() === signature) {
		return { ran: false, ok: true, durationMs: 0, output: '' };
	}
	/* The seeded lockfile describes the host projects, so a frozen install would
	   refuse it; the session always re-resolves its own importers. */
	const runCommand = options.runCommand ?? runPnpm;
	let result = await runCommand(options.sessionWorkspace, [
		'install',
		'--offline',
		'--no-frozen-lockfile',
	]);
	if (result.code !== 0) {
		result = await runCommand(options.sessionWorkspace, [
			'install',
			'--prefer-offline',
			'--no-frozen-lockfile',
		]);
	}
	if (result.code === 0) {
		await writeFile(signaturePath, signature, 'utf8');
	}
	return {
		ran: true,
		ok: result.code === 0,
		durationMs: Date.now() - startedAt,
		output: result.output.trim(),
	};
}
