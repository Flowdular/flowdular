import { flowdularStateDirectory } from '@flowdular/kernel/runtime-config';
import { constants } from 'node:fs';
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	readFile,
	rm,
	stat,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import {
	failure,
	success,
	type CommandEnvelope,
} from '@flowdular/cli-protocol';
import { LEGACY_DATA_DIRECTORY } from '@flowdular/kernel/legacy-local-state';
import type { Workspace } from './workspace.ts';

/* Sources are copied, never moved or deleted. The legacy name comes only from
   the shared startup guard. Remove both after pre-Flowdular workspaces no longer
   need this migration. */
const STATE_FILES = [
	'agents.db',
	'auth.db',
	'automations.db',
	'catalog.db',
	'expenses.db',
	'parties.db',
	'profile.db',
	'sandbox.db',
	'agent-credential.key',
	'agent-run-grant.key',
	'automations-credential.key',
] as const;

const DATABASE_FILES: ReadonlySet<string> = new Set(
	STATE_FILES.filter((name) => name.endsWith('.db')),
);

interface FilePlan {
	readonly name: string;
	readonly source: string;
	readonly destination: string;
}

interface StateMigrationPlan {
	readonly sourceDirectory: string;
	readonly destinationDirectory: string;
	readonly files: readonly FilePlan[];
	readonly missing: readonly string[];
	readonly blockers: readonly string[];
}

function isMissing(error: unknown): boolean {
	return (
		error instanceof Error &&
		'code' in error &&
		(error as NodeJS.ErrnoException).code === 'ENOENT'
	);
}

async function pathState(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

function relativePath(workspace: Workspace, path: string): string {
	return relative(workspace.root, path);
}

async function migrationPlan(
	workspace: Workspace,
): Promise<StateMigrationPlan> {
	const sourceDirectory = join(workspace.root, LEGACY_DATA_DIRECTORY);
	const stateDirectory = flowdularStateDirectory(workspace.root);
	const destinationDirectory = join(stateDirectory, 'data');
	const destinationLabel = relativePath(workspace, destinationDirectory);
	const blockers: string[] = [];
	const missing: string[] = [];
	const files: FilePlan[] = [];
	const sourceState = await pathState(sourceDirectory);
	if (sourceState?.isSymbolicLink()) {
		blockers.push(`${LEGACY_DATA_DIRECTORY} is a symbolic link.`);
	} else if (sourceState && !sourceState.isDirectory()) {
		blockers.push(`${LEGACY_DATA_DIRECTORY} is not a directory.`);
	}
	for (const directory of [stateDirectory, destinationDirectory]) {
		const state = await pathState(directory);
		if (state?.isSymbolicLink()) {
			blockers.push(
				`${relativePath(workspace, directory)} is a symbolic link.`,
			);
		} else if (state && !state.isDirectory()) {
			blockers.push(
				`${relativePath(workspace, directory)} is not a directory.`,
			);
		}
	}
	if (!sourceState?.isDirectory()) {
		return {
			sourceDirectory,
			destinationDirectory,
			files,
			missing: [...STATE_FILES],
			blockers,
		};
	}
	for (const name of STATE_FILES) {
		const source = join(sourceDirectory, name);
		const destination = join(destinationDirectory, name);
		const sourceFile = await pathState(source);
		if (!sourceFile) {
			missing.push(name);
			continue;
		}
		if (sourceFile.isSymbolicLink() || !sourceFile.isFile()) {
			blockers.push(`${LEGACY_DATA_DIRECTORY}/${name} is not a regular file.`);
			continue;
		}
		let blocked = false;
		if (await pathState(destination)) {
			blockers.push(`${destinationLabel}/${name} already exists.`);
			blocked = true;
		}
		if (DATABASE_FILES.has(name)) {
			for (const suffix of ['-wal', '-shm', '-journal']) {
				if (await pathState(`${destination}${suffix}`)) {
					blockers.push(`${destinationLabel}/${name}${suffix} already exists.`);
					blocked = true;
				}
				if (await pathState(`${source}${suffix}`)) {
					blockers.push(
						`${LEGACY_DATA_DIRECTORY}/${name}${suffix} exists. Stop every Flowdular process and close database clients before migrating.`,
					);
					blocked = true;
				}
			}
		}
		if (!blocked) files.push({ name, source, destination });
	}
	return { sourceDirectory, destinationDirectory, files, missing, blockers };
}

async function digest(path: string): Promise<string> {
	return createHash('sha256')
		.update(await readFile(path))
		.digest('hex');
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if (
			!(
				error instanceof Error &&
				'code' in error &&
				(error as NodeJS.ErrnoException).code === 'EEXIST'
			)
		)
			throw error;
	}
	const state = await lstat(path);
	if (state.isSymbolicLink() || !state.isDirectory()) {
		throw new Error(`${path} is not a safe local state directory.`);
	}
	await chmod(path, 0o700);
}

async function copyPlan(plan: StateMigrationPlan): Promise<void> {
	await ensurePrivateDirectory(dirname(plan.destinationDirectory));
	await ensurePrivateDirectory(plan.destinationDirectory);
	const created: string[] = [];
	try {
		for (const file of plan.files) {
			const sourceState = await lstat(file.source);
			if (sourceState.isSymbolicLink() || !sourceState.isFile()) {
				throw new Error(`${file.name} is no longer a regular file.`);
			}
			const before = await stat(file.source);
			await copyFile(file.source, file.destination, constants.COPYFILE_EXCL);
			created.push(file.destination);
			await chmod(file.destination, 0o600);
			const [sourceDigest, destinationDigest, after] = await Promise.all([
				digest(file.source),
				digest(file.destination),
				stat(file.source),
			]);
			if (
				sourceDigest !== destinationDigest ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs
			) {
				throw new Error(`Source changed while copying ${file.name}.`);
			}
			if (DATABASE_FILES.has(file.name)) {
				for (const suffix of ['-wal', '-shm', '-journal']) {
					if (await pathState(`${file.source}${suffix}`)) {
						throw new Error(
							`Database sidecar appeared while copying ${file.name}.`,
						);
					}
				}
			}
		}
		for (const file of plan.files) {
			if ((await digest(file.source)) !== (await digest(file.destination))) {
				throw new Error(`Source changed after copying ${file.name}.`);
			}
			if (DATABASE_FILES.has(file.name)) {
				for (const suffix of ['-wal', '-shm', '-journal']) {
					if (await pathState(`${file.source}${suffix}`)) {
						throw new Error(
							`Database sidecar appeared after copying ${file.name}.`,
						);
					}
				}
			}
		}
	} catch (error) {
		await Promise.all(created.map((path) => rm(path, { force: true })));
		throw error;
	}
}

function data(plan: StateMigrationPlan, applied: boolean) {
	return {
		applied,
		ready: plan.blockers.length === 0,
		source: LEGACY_DATA_DIRECTORY,
		destination: relative(
			dirname(dirname(plan.destinationDirectory)),
			plan.destinationDirectory,
		),
		files: plan.files.map((file) => file.name),
		missing: plan.missing,
		blockers: plan.blockers,
		sourcePreserved: true,
	};
}

export async function migrateLegacyState(
	workspace: Workspace,
	apply: boolean,
): Promise<CommandEnvelope> {
	const plan = await migrationPlan(workspace);
	if (apply && plan.blockers.length > 0) {
		return failure(
			'LEGACY_STATE_MIGRATION_REFUSED',
			'Legacy local state is not safe to copy.',
			data(plan, false),
		);
	}
	if (!apply) {
		return success(data(plan, false), {
			evidence: plan.files.map(
				(file) => `${LEGACY_DATA_DIRECTORY}/${file.name}`,
			),
			warnings: [
				...(plan.blockers.length > 0
					? ['Resolve every blocker before applying the migration.']
					: []),
				'No files were changed. Stop the platform and sandbox, then pass --apply --confirm migrate-legacy-state.',
			],
		});
	}
	try {
		await copyPlan(plan);
	} catch (error) {
		return failure(
			'LEGACY_STATE_COPY_FAILED',
			error instanceof Error ? error.message : String(error),
			data(plan, false),
		);
	}
	return success(data(plan, true), {
		evidence: plan.files.map((file) =>
			relativePath(workspace, join(plan.destinationDirectory, file.name)),
		),
		warnings: [
			`The source directory ${LEGACY_DATA_DIRECTORY} was preserved. Remove it only after verifying the new Flowdular data directory.`,
		],
	});
}
