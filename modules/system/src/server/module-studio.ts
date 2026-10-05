import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
	ModuleChangePlan,
	ModuleInstallLock,
	ModuleSource,
} from '@flowdular/contracts';

const ID = /^[a-f0-9]{64}\.json$/;
const HASH = /^[a-f0-9]{64}$/;
const MODULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const MAX_PLANS = 32;
const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

function safeSource(source: unknown): source is ModuleSource {
	if (!source || typeof source !== 'object') return false;
	const value = source as ModuleSource;
	if (
		(value.kind !== 'catalog' && value.kind !== 'git') ||
		typeof value.location !== 'string' ||
		value.location.length === 0 ||
		value.location.length > 2048
	)
		return false;
	if (value.location.startsWith('https://')) {
		const url = new URL(value.location);
		if (url.username || url.password || url.search || url.hash) return false;
	} else if (/^[a-z][a-z0-9+.-]*:/i.test(value.location)) return false;
	if (value.kind === 'catalog') return true;
	return (
		typeof value.commit === 'string' &&
		/^[a-f0-9]{40}$/.test(value.commit) &&
		typeof value.catalogPath === 'string' &&
		value.catalogPath.length < 240 &&
		/^[a-zA-Z0-9_./-]+\.json$/.test(value.catalogPath) &&
		!value.catalogPath
			.split('/')
			.some((part) => !part || part === '.' || part === '..')
	);
}

export interface ModuleStudioState {
	readonly sources: readonly { name: string; source: ModuleSource }[];
	readonly plans: readonly ModuleChangePlan[];
	readonly installed: ModuleInstallLock['modules'];
	readonly issues: readonly string[];
}

function readBounded(path: string, maxBytes: number): string {
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes)
		throw new Error('Module Studio file is not a bounded regular file.');
	return readFileSync(path, 'utf8');
}

function optionalJson(path: string): unknown | null {
	if (!existsSync(path)) return null;
	return JSON.parse(readBounded(path, 1024 * 1024));
}

function validPlan(
	value: unknown,
	filename: string,
): value is ModuleChangePlan {
	if (!value || typeof value !== 'object') return false;
	const plan = value as ModuleChangePlan;
	if (
		plan.schemaVersion !== 1 ||
		plan.id + '.json' !== filename ||
		typeof plan.target !== 'string' ||
		!MODULE_ID.test(plan.target.split('@')[0] ?? '') ||
		typeof plan.sourceName !== 'string' ||
		!/^[a-z][a-z0-9-]{0,31}$/.test(plan.sourceName) ||
		!safeSource(plan.source) ||
		!Array.isArray(plan.releases) ||
		plan.releases.length === 0 ||
		plan.releases.length > 256 ||
		!Array.isArray(plan.changes) ||
		plan.changes.length !== plan.releases.length ||
		!plan.releases.every(
			(release) =>
				release &&
				release.manifest &&
				MODULE_ID.test(release.manifest.id) &&
				typeof release.manifest.version === 'string' &&
				release.manifest.version.length <= 64 &&
				HASH.test(release.sha256),
		) ||
		!plan.changes.every(
			(change, index) =>
				change &&
				change.id === plan.releases[index]?.manifest.id &&
				change.version === plan.releases[index]?.manifest.version &&
				change.sha256 === plan.releases[index]?.sha256 &&
				(change.action === 'install' || change.action === 'update') &&
				MODULE_ID.test(change.id) &&
				typeof change.version === 'string' &&
				change.version.length <= 64 &&
				HASH.test(change.sha256) &&
				Array.isArray(change.dependencies) &&
				change.dependencies.length <= 256 &&
				change.dependencies.every(
					(item: unknown) => typeof item === 'string' && item.length <= 128,
				) &&
				Array.isArray(change.permissions) &&
				change.permissions.length <= 256 &&
				change.permissions.every(
					(item: unknown) => typeof item === 'string' && item.length <= 128,
				) &&
				Array.isArray(change.migrations) &&
				change.migrations.length <= 256 &&
				change.migrations.every((item: unknown) => {
					if (!item || typeof item !== 'object') return false;
					const migration = item as { path?: unknown; sha256?: unknown };
					return (
						typeof migration.path === 'string' &&
						migration.path.length <= 240 &&
						typeof migration.sha256 === 'string' &&
						HASH.test(migration.sha256)
					);
				}) &&
				change.surfaces &&
				typeof change.surfaces.server === 'boolean' &&
				typeof change.surfaces.client === 'boolean',
		)
	)
		return false;
	const { id, createdAt, ...content } = plan;
	const digest = createHash('sha256')
		.update(JSON.stringify(content))
		.digest('hex');
	return (
		digest === id && typeof createdAt === 'string' && createdAt.length <= 40
	);
}

/** Plans are build-time data in Docker and workspace files in development. */
export function readModuleStudioState(
	workspaceRoot: string,
): ModuleStudioState {
	const issues: string[] = [];
	let sources: ModuleStudioState['sources'] = [];
	let installed: ModuleStudioState['installed'] = [];
	try {
		const raw = optionalJson(
			join(workspaceRoot, 'flowdular.module-sources.json'),
		) as {
			schemaVersion?: number;
			sources?: ModuleStudioState['sources'];
		} | null;
		if (
			raw &&
			raw.schemaVersion === 1 &&
			Array.isArray(raw.sources) &&
			raw.sources.length <= 32 &&
			raw.sources.every(
				(item) =>
					item &&
					/^[a-z][a-z0-9-]{0,31}$/.test(item.name) &&
					safeSource(item.source),
			)
		)
			sources = raw.sources;
		else if (raw) issues.push('Module source list is invalid.');
	} catch {
		issues.push('Module source list could not be read.');
	}
	try {
		const raw = optionalJson(
			join(workspaceRoot, 'flowdular.modules.lock.json'),
		) as ModuleInstallLock | null;
		if (
			raw &&
			raw.schemaVersion === 1 &&
			Array.isArray(raw.modules) &&
			raw.modules.length <= 256 &&
			raw.modules.every(
				(entry) => entry && MODULE_ID.test(entry.id) && HASH.test(entry.sha256),
			)
		)
			installed = raw.modules;
		else if (raw) issues.push('Module lockfile is invalid.');
	} catch {
		issues.push('Module lockfile could not be read.');
	}
	const directory = join(workspaceRoot, 'module-plans');
	if (!existsSync(directory)) return { sources, installed, plans: [], issues };
	let directoryValid = false;
	try {
		const info = lstatSync(directory);
		directoryValid = info.isDirectory() && !info.isSymbolicLink();
	} catch {
		// A concurrent checkout change is reported as invalid state.
	}
	if (!directoryValid) {
		issues.push('Module plan directory is invalid.');
		return { sources, installed, plans: [], issues };
	}
	let files: string[];
	try {
		files = readdirSync(directory);
	} catch {
		issues.push('Module plan directory could not be read.');
		return { sources, installed, plans: [], issues };
	}
	if (files.length > MAX_PLANS) {
		issues.push('The module plan limit was exceeded.');
		return { sources, installed, plans: [], issues };
	}
	const plans: ModuleChangePlan[] = [];
	let totalBytes = 0;
	for (const file of files) {
		if (!ID.test(file)) {
			issues.push('A module plan has an invalid filename.');
			continue;
		}
		try {
			const path = join(directory, file);
			const size = lstatSync(path).size;
			totalBytes += size;
			if (totalBytes > MAX_TOTAL_BYTES)
				throw new Error('Module plan collection is too large.');
			const value = JSON.parse(readBounded(path, MAX_PLAN_BYTES)) as unknown;
			if (!validPlan(value, file))
				throw new Error('Module plan contents differ from their id.');
			plans.push(value);
		} catch {
			issues.push(`Module plan ${file} could not be verified.`);
		}
	}
	return {
		sources,
		installed,
		plans: plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
		issues,
	};
}
