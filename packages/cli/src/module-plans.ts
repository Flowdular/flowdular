import {
	readFile,
	readdir,
	mkdir,
	rename,
	writeFile,
	rm,
	lstat,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
	ModuleArtifact,
	ModuleChangePlan,
	ModuleManifest,
	ModuleRelease,
	ModuleSource,
} from '@flowdular/contracts';
import {
	distributionAssert,
	hashBytes,
	validateModuleArtifact,
} from './module-artifact.ts';
import {
	readRelease,
	resolveModuleReleases,
	type CatalogSource,
} from './module-catalog.ts';
import { findModuleFiles } from './module-files.ts';
import {
	installPlannedModule,
	validateInstalledModules,
} from './module-install.ts';
import { readModuleSources, withModuleSource } from './module-sources.ts';
import type { Workspace } from './workspace.ts';

const DIRECTORY = 'module-plans';
const PLAN_ID = /^[a-f0-9]{64}$/;
const MAX_PLANS = 32;
const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

function planDirectory(workspace: Workspace): string {
	return join(workspace.root, DIRECTORY);
}

function checkedPlanFiles(files: readonly string[]): void {
	distributionAssert(
		files.length <= MAX_PLANS &&
			files.every(
				(file) => file.endsWith('.json') && PLAN_ID.test(file.slice(0, -5)),
			),
		'MODULE_PLAN_INVALID',
		'Invalid module plan directory.',
	);
}

async function planCollectionBytes(
	directory: string,
	files: readonly string[],
): Promise<number> {
	let total = 0;
	for (const file of files) {
		const info = await lstat(join(directory, file));
		distributionAssert(
			info.isFile() && !info.isSymbolicLink() && info.size <= MAX_PLAN_BYTES,
			'MODULE_PLAN_INVALID',
			'Module plan is not a bounded regular file.',
		);
		total += info.size;
	}
	return total;
}

async function checkedPlanDirectory(workspace: Workspace): Promise<string> {
	const directory = planDirectory(workspace);
	const info = await lstat(directory);
	distributionAssert(
		info.isDirectory() && !info.isSymbolicLink(),
		'MODULE_PLAN_INVALID',
		'Module plan directory is not a regular directory.',
	);
	return directory;
}

async function lockDigest(workspace: Workspace): Promise<string | null> {
	try {
		return hashBytes(
			await readFile(join(workspace.root, 'flowdular.modules.lock.json')),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

async function workspaceDigest(workspace: Workspace): Promise<string> {
	const files = await findModuleFiles(workspace);
	const manifests: [string, string][] = [];
	for (const file of files)
		manifests.push([
			relative(workspace.root, file),
			hashBytes(await readFile(file)),
		]);
	return hashBytes(
		JSON.stringify(manifests.sort(([a], [b]) => a.localeCompare(b))),
	);
}

function planId(plan: Omit<ModuleChangePlan, 'id' | 'createdAt'>): string {
	return hashBytes(JSON.stringify(plan));
}

function permissions(artifact: ModuleArtifact): readonly string[] {
	const file = artifact.files.find(
		(entry) => entry.path === 'spec/module.yaml',
	);
	distributionAssert(
		file,
		'MODULE_SPEC_INVALID',
		'Module release is missing its specification.',
	);
	const spec = parseYaml(
		Buffer.from(file.content, 'base64').toString('utf8'),
	) as {
		status?: string;
		permissions?: { id?: string }[];
	};
	distributionAssert(
		spec.status === 'approved',
		'MODULE_SPEC_NOT_APPROVED',
		'Distributed module source must contain an approved specification.',
	);
	return (spec.permissions ?? []).flatMap((permission) =>
		typeof permission.id === 'string' ? [permission.id] : [],
	);
}

async function plannedReleases(
	workspace: Workspace,
	source: CatalogSource,
	target: string,
	update: boolean,
): Promise<{
	releases: readonly ModuleRelease[];
	changes: ModuleChangePlan['changes'];
}> {
	const manifests: ModuleManifest[] = [];
	for (const file of await findModuleFiles(workspace))
		manifests.push(JSON.parse(await readFile(file, 'utf8')) as ModuleManifest);
	const targetId = target.split('@')[0]!;
	if (update) {
		const lock = await validateInstalledModules(workspace);
		distributionAssert(
			lock.modules.some((entry) => entry.id === targetId),
			'MODULE_NOT_MANAGED',
			`Module ${targetId} is not managed by the installer.`,
		);
	} else
		distributionAssert(
			!manifests.some((manifest) => manifest.id === targetId),
			'MODULE_NOT_MANAGED',
			`Module ${targetId} already exists in this workspace.`,
		);
	const retained = update
		? manifests.filter((manifest) => manifest.id !== targetId)
		: manifests;
	const releases = resolveModuleReleases(source.catalog, target, retained);
	distributionAssert(
		releases.length > 0,
		'MODULE_PLAN_EMPTY',
		'This source has no new release for the requested module.',
	);
	const inspected = await inspectReleases(source, releases, targetId, update);
	return { releases, changes: inspected.changes };
}

async function inspectReleases(
	source: CatalogSource,
	releases: readonly ModuleRelease[],
	targetId: string,
	update: boolean,
): Promise<{
	changes: ModuleChangePlan['changes'];
	artifacts: ReadonlyMap<string, Buffer>;
}> {
	const changes: ModuleChangePlan['changes'][number][] = [];
	const artifacts = new Map<string, Buffer>();
	let totalBytes = 0;
	for (const release of releases) {
		const bytes = await readRelease(source, release);
		artifacts.set(release.manifest.id, bytes);
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
		changes.push({
			id: release.manifest.id,
			version: release.manifest.version,
			sha256: release.sha256,
			action: update && release.manifest.id === targetId ? 'update' : 'install',
			dependencies: release.manifest.dependencies.map(
				(dependency) => dependency.id,
			),
			permissions: permissions(artifact),
			migrations: artifact.files
				.filter((file) => file.path.startsWith('migrations/'))
				.map((file) => ({ path: file.path, sha256: file.sha256 })),
			surfaces: {
				server: release.manifest.capabilities.some(
					(item) =>
						item === 'api' || item === 'database' || item === 'integration',
				),
				client: release.manifest.capabilities.includes('client'),
			},
		});
	}
	return { changes, artifacts };
}

export async function createModulePlan(
	workspace: Workspace,
	options: {
		readonly target: string;
		readonly sourceName: string;
		readonly update: boolean;
		readonly save: boolean;
	},
): Promise<ModuleChangePlan> {
	const named = (await readModuleSources(workspace)).find(
		(item) => item.name === options.sourceName,
	);
	distributionAssert(
		named,
		'MODULE_SOURCE_MISSING',
		`Unknown module source ${options.sourceName}.`,
	);
	const expectedLockSha256 = await lockDigest(workspace);
	const expectedWorkspaceSha256 = await workspaceDigest(workspace);
	const selected = await withModuleSource(workspace, named.source, (source) =>
		plannedReleases(workspace, source, options.target, options.update),
	);
	const content = {
		schemaVersion: 1 as const,
		target: options.target,
		sourceName: named.name,
		source: named.source,
		update: options.update,
		expectedLockSha256,
		expectedWorkspaceSha256,
		releases: selected.releases,
		changes: selected.changes,
		requiresBuild: true as const,
		requiresRestart: true as const,
		activation: 'host-cli' as const,
	};
	const id = planId(content);
	const plan: ModuleChangePlan = {
		...content,
		id,
		createdAt: new Date().toISOString(),
	};
	if (options.save) {
		const serialized = JSON.stringify(plan, null, '\t') + '\n';
		const bytes = Buffer.byteLength(serialized);
		distributionAssert(
			bytes <= MAX_PLAN_BYTES,
			'MODULE_PLAN_LIMIT',
			'Module plan exceeds the 4 MiB file limit.',
		);
		const lock = planDirectory(workspace) + '.lock';
		try {
			await mkdir(lock);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST')
				distributionAssert(
					false,
					'MODULE_PLAN_BUSY',
					'Another module plan write is active. Retry after it finishes.',
				);
			throw error;
		}
		try {
			const directory = planDirectory(workspace);
			await mkdir(directory, { recursive: true });
			await checkedPlanDirectory(workspace);
			const files = await readdir(directory);
			checkedPlanFiles(files);
			const name = `${id}.json`;
			if (files.includes(name)) return readModulePlan(workspace, id);
			distributionAssert(
				files.length < MAX_PLANS,
				'MODULE_PLAN_LIMIT',
				'The workspace has 32 plans. Remove an obsolete plan first.',
			);
			distributionAssert(
				(await planCollectionBytes(directory, files)) + bytes <=
					MAX_TOTAL_BYTES,
				'MODULE_PLAN_LIMIT',
				'The workspace has 8 MiB of module plans. Remove an obsolete plan first.',
			);
			const temp = join(lock, `${randomUUID()}.tmp`);
			await writeFile(temp, serialized, { flag: 'wx' });
			await rename(temp, join(directory, name));
		} finally {
			await rm(lock, { recursive: true, force: true });
		}
	}
	return plan;
}

export async function readModulePlan(
	workspace: Workspace,
	id: string,
): Promise<ModuleChangePlan> {
	distributionAssert(
		PLAN_ID.test(id),
		'MODULE_PLAN_INVALID',
		'Invalid module plan id.',
	);
	const path = join(await checkedPlanDirectory(workspace), `${id}.json`);
	const info = await lstat(path);
	distributionAssert(
		info.isFile() && !info.isSymbolicLink() && info.size <= MAX_PLAN_BYTES,
		'MODULE_PLAN_INVALID',
		'Module plan is not a bounded regular file.',
	);
	const raw = await readFile(path, 'utf8');
	const plan = JSON.parse(raw) as ModuleChangePlan;
	distributionAssert(
		plan && typeof plan === 'object',
		'MODULE_PLAN_INVALID',
		'Module plan is not an object.',
	);
	const { id: recordedId, createdAt, ...content } = plan;
	distributionAssert(
		plan.schemaVersion === 1 &&
			recordedId === id &&
			typeof createdAt === 'string' &&
			Array.isArray(plan.releases) &&
			plan.releases.length > 0 &&
			plan.releases.length <= 256 &&
			Array.isArray(plan.changes) &&
			plan.changes.length === plan.releases.length &&
			plan.changes.every((change, index) => {
				const release = plan.releases[index];
				return (
					change &&
					release?.manifest &&
					change.id === release.manifest.id &&
					change.version === release.manifest.version &&
					change.sha256 === release.sha256 &&
					(change.action === 'install' || change.action === 'update')
				);
			}) &&
			planId(content) === id,
		'MODULE_PLAN_INVALID',
		'Module plan contents differ from its id.',
	);
	return plan;
}

export async function listModulePlans(
	workspace: Workspace,
): Promise<readonly ModuleChangePlan[]> {
	let files: string[];
	try {
		files = await readdir(await checkedPlanDirectory(workspace));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	checkedPlanFiles(files);
	distributionAssert(
		(await planCollectionBytes(planDirectory(workspace), files)) <=
			MAX_TOTAL_BYTES,
		'MODULE_PLAN_LIMIT',
		'The workspace has more than 8 MiB of module plans.',
	);
	const plans: ModuleChangePlan[] = [];
	for (const file of files)
		plans.push(await readModulePlan(workspace, file.slice(0, -5)));
	return plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function removeModulePlan(
	workspace: Workspace,
	id: string,
	apply: boolean,
) {
	await readModulePlan(workspace, id);
	if (apply) await rm(join(planDirectory(workspace), `${id}.json`));
	return { id, applied: apply };
}

export async function applyModulePlan(
	workspace: Workspace,
	id: string,
	apply: boolean,
) {
	const plan = await readModulePlan(workspace, id);
	distributionAssert(
		(await workspaceDigest(workspace)) === plan.expectedWorkspaceSha256,
		'MODULE_PLAN_STALE',
		'Workspace modules changed since the plan was created. Create a new plan.',
	);
	return withModuleSource(workspace, plan.source, async (source) => {
		const inspected = await inspectReleases(
			source,
			plan.releases,
			plan.target.split('@')[0]!,
			plan.update,
		);
		distributionAssert(
			JSON.stringify(inspected.changes) === JSON.stringify(plan.changes),
			'MODULE_PLAN_CHANGED',
			'The plan impact differs from the pinned source. Create a new plan.',
		);
		const report = await installPlannedModule(workspace, {
			target: plan.target,
			apply,
			update: plan.update,
			prepared: {
				releases: plan.releases,
				artifacts: inspected.artifacts,
			},
			expectedLockSha256: plan.expectedLockSha256,
		});
		return { plan, ...report };
	});
}
