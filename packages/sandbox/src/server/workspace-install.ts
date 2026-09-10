import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { SessionModule } from './sessions.ts';

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

function yamlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
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
	const overrides: string[] = [];
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
			overrides.push(
				`  ${yamlString(name)}: ${yamlString(`link:${directory}`)}`,
			);
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
		overrides.push(`  '@flowdular/sdk': ${yamlString(`link:${sdkRoot}`)}`);
	} catch (error) {
		if (
			!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(
				(error as NodeJS.ErrnoException).code ?? '',
			)
		)
			throw error;
	}
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
				...(sdkVersion
					? { dependencies: { '@flowdular/sdk': sdkVersion } }
					: {}),
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
	const carried = hostWorkspace
		.split('\n')
		.filter(
			(line) =>
				!/^(packages|overrides):/.test(line) &&
				!/^\s+-\s+(platform|modules\/\*|packages\/\*)\s*$/.test(line),
		)
		.join('\n')
		.trim();
	await writeFile(
		join(options.sessionWorkspace, 'pnpm-workspace.yaml'),
		`${[
			'packages:',
			'  - modules/*',
			/* Host patches travel along even when no draft depends on the patched
			   package; pnpm must not treat that as an error. */
			'allowUnusedPatches: true',
			carried,
			'overrides:',
			...overrides,
		]
			.filter(Boolean)
			.join('\n')}\n`,
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

function runPnpm(
	cwd: string,
	args: readonly string[],
): Promise<{ code: number | null; output: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn('pnpm', [...args], {
			cwd,
			env: { ...process.env, FORCE_COLOR: '0' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let output = '';
		const append = (chunk: string) => {
			output = (output + chunk).slice(-OUTPUT_LIMIT);
		};
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		const timer = setTimeout(() => {
			append('\nThe install exceeded its time budget and was stopped.');
			child.kill('SIGKILL');
		}, INSTALL_TIMEOUT_MS);
		timer.unref();
		child.on('error', (error) => {
			clearTimeout(timer);
			resolvePromise({ code: null, output: `${output}\n${error.message}` });
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolvePromise({ code, output });
		});
	});
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
	let result = await runPnpm(options.sessionWorkspace, [
		'install',
		'--offline',
		'--no-frozen-lockfile',
	]);
	if (result.code !== 0) {
		result = await runPnpm(options.sessionWorkspace, [
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
