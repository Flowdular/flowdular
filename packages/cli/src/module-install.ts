import {
	lstat,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type {
	InstalledModule,
	ModuleInstallLock,
	ModuleManifest,
	ModuleRelease,
} from '@flowdular/contracts';
import { compareModuleVersions, createModuleRegistry } from '@flowdular/kernel';
import {
	distributionAssert,
	hashBytes,
	safeSourcePath,
	validateModuleArtifact,
} from './module-artifact.ts';
import {
	loadModuleCatalog,
	readRelease,
	resolveModuleReleases,
} from './module-catalog.ts';
import { findModuleFiles, moduleRoots } from './module-files.ts';
import { moduleLayoutIssues } from './module-validate.ts';
import {
	resolveExistingInside,
	resolveInside,
	type Workspace,
} from './workspace.ts';

const LOCK = 'flowdular.modules.lock.json';
const TRANSACTION = '.flowdular-module-install';
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}
async function safeParents(workspace: Workspace, path: string): Promise<void> {
	const parts = relative(
		workspace.root,
		resolveInside(workspace.root, path),
	).split('/');
	let current = workspace.root;
	for (const part of parts) {
		current = join(current, part);
		if (!(await exists(current))) break;
		distributionAssert(
			!(await lstat(current)).isSymbolicLink(),
			'MODULE_DESTINATION_LINK',
			'Module installation paths cannot contain links.',
		);
	}
}
function validateLock(workspace: Workspace, value: unknown): ModuleInstallLock {
	const lock = value as ModuleInstallLock;
	distributionAssert(
		lock &&
			lock.schemaVersion === 1 &&
			Array.isArray(lock.modules) &&
			lock.modules.length <= 256,
		'MODULE_LOCK_INVALID',
		'Invalid module lockfile.',
	);
	const ids = new Set<string>();
	const dirs = new Set<string>();
	for (const entry of lock.modules) {
		distributionAssert(
			entry &&
				typeof entry.id === 'string' &&
				typeof entry.version === 'string' &&
				typeof entry.directory === 'string' &&
				entry.files &&
				typeof entry.files === 'object' &&
				!Array.isArray(entry.files),
			'MODULE_LOCK_INVALID',
			'Invalid installed module entry.',
		);
		const path = resolveInside(workspace.root, entry.directory);
		distributionAssert(
			moduleRoots(workspace).some((root) => dirname(path) === root) &&
				!ids.has(entry.id) &&
				!dirs.has(path.toLowerCase()),
			'MODULE_LOCK_INVALID',
			'Duplicate or invalid installed module path.',
		);
		ids.add(entry.id);
		dirs.add(path.toLowerCase());
		distributionAssert(
			Object.entries(entry.files).every(
				([path, hash]) =>
					safeSourcePath(path) &&
					typeof hash === 'string' &&
					/^[a-f0-9]{64}$/.test(hash),
			),
			'MODULE_LOCK_INVALID',
			'Invalid module file hashes.',
		);
	}
	return lock;
}
async function readLock(
	workspace: Workspace,
): Promise<{ lock: ModuleInstallLock; raw: string | null }> {
	const path = join(workspace.root, LOCK);
	await safeParents(workspace, path);
	if (!(await exists(path)))
		return { lock: { schemaVersion: 1, modules: [] }, raw: null };
	const raw = await readFile(path, 'utf8');
	return { lock: validateLock(workspace, JSON.parse(raw)), raw };
}
async function directoryHashes(root: string): Promise<Record<string, string>> {
	const hashes: Record<string, string> = Object.create(null) as Record<
		string,
		string
	>;
	async function visit(directory: string, prefix: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (
				entry.name === 'node_modules' ||
				entry.name === 'dist' ||
				entry.name === '.git'
			)
				continue;
			distributionAssert(
				!entry.isSymbolicLink(),
				'MODULE_LOCAL_CHANGES',
				'Installed module contains a symbolic link.',
			);
			const path = prefix + entry.name;
			if (entry.isDirectory())
				await visit(join(directory, entry.name), path + '/');
			else {
				distributionAssert(
					entry.isFile(),
					'MODULE_LOCAL_CHANGES',
					'Installed module contains a special file.',
				);
				hashes[path] = hashBytes(await readFile(join(directory, entry.name)));
			}
		}
	}
	await visit(root, '');
	return hashes;
}
function equalHashes(
	a: Readonly<Record<string, string>>,
	b: Readonly<Record<string, string>>,
): boolean {
	return (
		Object.keys(a).length === Object.keys(b).length &&
		Object.entries(a).every(([path, hash]) => b[path] === hash)
	);
}
async function assertUnmodified(
	workspace: Workspace,
	entry: InstalledModule,
): Promise<void> {
	const path = resolveInside(workspace.root, entry.directory);
	await safeParents(workspace, path);
	distributionAssert(
		(await exists(path)) &&
			equalHashes(await directoryHashes(path), entry.files),
		'MODULE_LOCAL_CHANGES',
		`Module ${entry.id} has local changes or is missing. Preserve/merge those changes before updating.`,
	);
}
export async function validateInstalledModules(
	workspace: Workspace,
): Promise<ModuleInstallLock> {
	const { lock, raw } = await readLock(workspace);
	distributionAssert(
		raw !== null,
		'MODULE_LOCK_MISSING',
		'No module lockfile exists.',
	);
	for (const entry of lock.modules) {
		await assertUnmodified(workspace, entry);
		const manifest = JSON.parse(
			await readFile(
				join(workspace.root, entry.directory, 'module.json'),
				'utf8',
			),
		) as ModuleManifest;
		distributionAssert(
			manifest.id === entry.id && manifest.version === entry.version,
			'MODULE_LOCK_INVALID',
			'Lock identity differs from the installed manifest.',
		);
	}
	return lock;
}
interface Journal {
	schemaVersion: 1;
	pid: number;
	previous: string | null;
	next: string;
	entries: { installed: InstalledModule; previous: InstalledModule | null }[];
}
async function rollback(workspace: Workspace, journal: Journal): Promise<void> {
	const transaction = join(workspace.root, TRANSACTION);
	// Validate before allowing the recovery journal to name any deletion target.
	validateLock(workspace, {
		schemaVersion: 1,
		modules: journal.entries.map((entry) => entry.installed),
	});
	for (const [index, entry] of [...journal.entries.entries()].reverse()) {
		const destination = resolveInside(
			workspace.root,
			entry.installed.directory,
		);
		await safeParents(workspace, destination);
		const backup = join(transaction, `backup-${index}`);
		const moved = !(await exists(join(transaction, `stage-${index}`)));
		if (moved && (await exists(destination))) {
			const hashes = await directoryHashes(destination);
			if (equalHashes(hashes, entry.installed.files))
				await rm(destination, { recursive: true });
			else
				distributionAssert(
					entry.previous &&
						equalHashes(hashes, entry.previous.files) &&
						!(await exists(backup)),
					'MODULE_RECOVERY_CONFLICT',
					`Recovery preserved modified files in ${entry.installed.directory}.`,
				);
		}
		if (await exists(backup)) {
			distributionAssert(
				!(await exists(destination)),
				'MODULE_RECOVERY_CONFLICT',
				'Recovery destination is occupied.',
			);
			await safeParents(workspace, backup);
			await rename(backup, destination);
		}
	}
	const lockPath = join(workspace.root, LOCK);
	await safeParents(workspace, lockPath);
	const current = (await exists(lockPath))
		? await readFile(lockPath, 'utf8')
		: null;
	distributionAssert(
		current === journal.previous || current === journal.next,
		'MODULE_RECOVERY_CONFLICT',
		'Lockfile changed during installation; recovery preserved it.',
	);
	if (journal.previous === null) await rm(lockPath, { force: true });
	else await writeFile(lockPath, journal.previous);
}
export async function recoverModuleInstall(
	workspace: Workspace,
	apply: boolean,
): Promise<{ recovered: boolean; pending: boolean }> {
	const transaction = join(workspace.root, TRANSACTION);
	await safeParents(workspace, transaction);
	if (!(await exists(transaction))) return { recovered: false, pending: false };
	const hasJournal = await exists(join(transaction, 'journal.json'));
	const journal = JSON.parse(
		await readFile(
			join(transaction, hasJournal ? 'journal.json' : 'owner.json'),
			'utf8',
		),
	) as Journal;
	distributionAssert(
		journal.schemaVersion === 1 &&
			Number.isSafeInteger(journal.pid) &&
			journal.pid > 0 &&
			(!hasJournal || Array.isArray(journal.entries)),
		'MODULE_JOURNAL_INVALID',
		'Invalid installation journal.',
	);
	let active = true;
	try {
		process.kill(journal.pid, 0);
	} catch (error) {
		active = (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
	distributionAssert(
		!active,
		'MODULE_INSTALL_BUSY',
		'The installation process is still running.',
	);
	if (!apply) return { recovered: false, pending: true };
	if (hasJournal) await rollback(workspace, journal);
	await rm(transaction, { recursive: true });
	return { recovered: true, pending: false };
}
export interface ModuleInstallOptions {
	readonly target: string;
	readonly registry?: string;
	readonly apply: boolean;
	readonly update?: boolean;
	readonly fetcher?: typeof fetch;
}
export async function installModule(
	workspace: Workspace,
	options: ModuleInstallOptions,
): Promise<{
	applied: boolean;
	modules: readonly InstalledModule[];
	activationRequired: boolean;
}> {
	const transaction = join(workspace.root, TRANSACTION);
	await safeParents(workspace, transaction);
	distributionAssert(
		!(await exists(transaction)),
		'MODULE_INSTALL_BUSY',
		'A module installation is active or interrupted. Use module recover after its process exits.',
	);
	const source = await loadModuleCatalog(options.registry, options.fetcher);
	const snapshot = await readLock(workspace);
	const manifests: ModuleManifest[] = [];
	for (const root of moduleRoots(workspace)) await safeParents(workspace, root);
	const files = await findModuleFiles(workspace);
	for (const file of files)
		manifests.push(JSON.parse(await readFile(file, 'utf8')) as ModuleManifest);
	const id = options.target.split('@')[0]!;
	const previous = snapshot.lock.modules.find((entry) => entry.id === id);
	distributionAssert(
		previous || !manifests.some((manifest) => manifest.id === id),
		'MODULE_NOT_MANAGED',
		`Module ${id} already exists as unmanaged workspace/package source.`,
	);
	if (options.update) {
		distributionAssert(
			previous,
			'MODULE_NOT_MANAGED',
			`Module ${id} is not managed by this installer.`,
		);
		await assertUnmodified(workspace, previous);
	}
	const retained = options.update
		? manifests.filter((manifest) => manifest.id !== id)
		: manifests;
	const releases = resolveModuleReleases(
		source.catalog,
		options.target,
		retained,
	);
	if (options.update) {
		const next = releases.find((release) => release.manifest.id === id);
		distributionAssert(
			next &&
				compareModuleVersions(next.manifest.version, previous!.version) <= 0,
			'MODULE_DOWNGRADE_FORBIDDEN',
			'Module downgrades are not supported.',
		);
	}
	// All installed dependents must also accept an updated dependency.
	const registry = createModuleRegistry(
		[...retained, ...releases.map((release) => release.manifest)].map(
			(manifest) => ({ manifest }),
		),
	);
	void registry;
	if (!releases.length) {
		if (previous) await assertUnmodified(workspace, previous);
		return { applied: false, modules: [], activationRequired: false };
	}
	const entries: {
		installed: InstalledModule;
		release: ModuleRelease;
		artifact: ReturnType<typeof validateModuleArtifact>;
		previous: InstalledModule | null;
	}[] = [];
	let totalBytes = 0;
	for (const release of releases) {
		const bytes = await readRelease(source, release, options.fetcher);
		totalBytes += bytes.length;
		distributionAssert(
			totalBytes <= 96 * 1024 * 1024,
			'MODULE_INSTALL_LIMIT',
			'The dependency closure exceeds the installation size limit.',
		);
		distributionAssert(
			hashBytes(bytes) === release.sha256,
			'MODULE_ARTIFACT_DIGEST',
			`Artifact digest mismatch for ${release.manifest.id}.`,
		);
		const artifact = validateModuleArtifact(JSON.parse(bytes.toString('utf8')));
		distributionAssert(
			JSON.stringify(artifact.manifest) === JSON.stringify(release.manifest),
			'MODULE_ARTIFACT_IDENTITY',
			'Catalog and artifact manifest differ.',
		);
		const old =
			snapshot.lock.modules.find((entry) => entry.id === release.manifest.id) ??
			null;
		const destination = old
			? resolveInside(workspace.root, old.directory)
			: join(
					moduleRoots(workspace)[0]!,
					release.manifest.package.replace('@flowdular/module-', ''),
				);
		await safeParents(workspace, destination);
		if (old) {
			distributionAssert(
				options.update && old.id === id,
				'MODULE_ALREADY_INSTALLED',
				`Module ${old.id} is already managed.`,
			);
			await assertUnmodified(workspace, old);
		} else
			distributionAssert(
				!(await exists(destination)),
				'MODULE_DESTINATION_EXISTS',
				`Destination exists: ${relative(workspace.root, destination)}`,
			);
		const hashes = Object.fromEntries(
			artifact.files.map((file) => [file.path, file.sha256]),
		);
		if (old)
			for (const [path, hash] of Object.entries(old.files))
				if (path.startsWith('migrations/'))
					distributionAssert(
						hashes[path] === hash,
						'MODULE_MIGRATION_CHANGED',
						`Update changes historical migration ${path}.`,
					);
		entries.push({
			release,
			artifact,
			previous: old,
			installed: {
				id: release.manifest.id,
				version: release.manifest.version,
				directory: relative(workspace.root, destination),
				artifact: release.artifact,
				sha256: release.sha256,
				sourceCommit: release.sourceCommit,
				files: hashes,
			},
		});
	}
	const nextLock: ModuleInstallLock = {
		schemaVersion: 1,
		modules: [
			...snapshot.lock.modules.filter(
				(entry) => !entries.some((next) => next.installed.id === entry.id),
			),
			...entries.map((entry) => entry.installed),
		].sort((a, b) => a.id.localeCompare(b.id)),
	};
	validateLock(workspace, nextLock);
	if (!options.apply)
		return {
			applied: false,
			modules: entries.map((entry) => entry.installed),
			activationRequired: true,
		};
	await mkdir(transaction); // Exclusive owner; never remove another installer's directory.
	const journal: Journal = {
		schemaVersion: 1,
		pid: process.pid,
		previous: snapshot.raw,
		next: JSON.stringify(nextLock, null, '\t') + '\n',
		entries: entries.map((entry) => ({
			installed: entry.installed,
			previous: entry.previous,
		})),
	};
	let journalWritten = false;
	try {
		await writeFile(
			join(transaction, 'owner.json'),
			JSON.stringify({ schemaVersion: 1, pid: process.pid }),
		);
		for (const [index, entry] of entries.entries()) {
			const stage = join(transaction, `stage-${index}`);
			await mkdir(stage);
			for (const file of entry.artifact.files) {
				const path = join(stage, file.path);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, Buffer.from(file.content, 'base64'), {
					flag: 'wx',
				});
			}
			const issues = await moduleLayoutIssues(stage, entry.artifact.manifest);
			distributionAssert(
				!issues.some((issue) => issue.severity === 'error'),
				'MODULE_LAYOUT_INVALID',
				`Invalid module layout: ${issues.map((issue) => issue.message).join('; ')}`,
			);
		}
		await writeFile(join(transaction, 'journal.tmp'), JSON.stringify(journal));
		await rename(
			join(transaction, 'journal.tmp'),
			join(transaction, 'journal.json'),
		);
		journalWritten = true;
		distributionAssert(
			(await readLock(workspace)).raw === snapshot.raw,
			'MODULE_CONCURRENT_CHANGE',
			'Module lock changed during planning.',
		);
		for (const [index, entry] of entries.entries()) {
			const destination = resolveInside(
				workspace.root,
				entry.installed.directory,
			);
			await safeParents(workspace, destination);
			if (entry.previous) {
				await assertUnmodified(workspace, entry.previous);
				await rename(destination, join(transaction, `backup-${index}`));
			} else
				distributionAssert(
					!(await exists(destination)),
					'MODULE_DESTINATION_EXISTS',
					`Destination appeared during installation: ${entry.installed.directory}`,
				);
			await mkdir(dirname(destination), { recursive: true });
			await rename(join(transaction, `stage-${index}`), destination);
		}
		await writeFile(join(transaction, 'next-lock.json'), journal.next);
		await rename(
			join(transaction, 'next-lock.json'),
			join(workspace.root, LOCK),
		);
	} catch (error) {
		if (journalWritten) await rollback(workspace, journal);
		await rm(transaction, { recursive: true });
		throw error;
	}
	await rm(transaction, { recursive: true });
	return {
		applied: true,
		modules: entries.map((entry) => entry.installed),
		activationRequired: true,
	};
}
