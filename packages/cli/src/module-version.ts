import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
	failure,
	success,
	type CommandEnvelope,
} from '@flowdular/cli-protocol';
import type { ModuleManifest } from '@flowdular/contracts';
import {
	incrementModuleVersion,
	retargetModuleRange,
	type ModuleVersionLevel,
} from '@flowdular/kernel';
import { findModuleFiles } from './module-files.ts';
import type { Workspace } from './workspace.ts';

const LOCK = 'flowdular.modules.lock.json';
const LEVELS: readonly ModuleVersionLevel[] = ['patch', 'minor', 'major'];

export interface ModuleVersionEdit {
	readonly path: string;
	readonly change: string;
}

export interface ModuleVersionReport {
	readonly id: string;
	readonly previous: string;
	readonly next: string;
	readonly applied: boolean;
	readonly files: readonly ModuleVersionEdit[];
	/* Dependents whose range could not be rewritten mechanically. */
	readonly manual: readonly string[];
}

interface LoadedModule {
	readonly file: string;
	readonly root: string;
	readonly manifest: ModuleManifest;
}

function specDirectory(workspace: Workspace): string {
	const configured = (
		workspace.config.specs as { moduleDirectory?: unknown } | undefined
	)?.moduleDirectory;
	return typeof configured === 'string' && configured ? configured : 'spec';
}

async function loadModules(workspace: Workspace): Promise<LoadedModule[]> {
	const modules: LoadedModule[] = [];
	for (const file of await findModuleFiles(workspace)) {
		const manifest = JSON.parse(await readFile(file, 'utf8')) as ModuleManifest;
		modules.push({ file, root: dirname(file), manifest });
	}
	return modules;
}

async function installerManaged(
	workspace: Workspace,
	id: string,
): Promise<boolean> {
	try {
		const lock = JSON.parse(
			await readFile(join(workspace.root, LOCK), 'utf8'),
		) as { modules?: { id?: unknown }[] };
		return (lock.modules ?? []).some((entry) => entry.id === id);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

function escape(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Text edits keep each file's formatting: a re-serialised JSON or YAML
   document would reflow lines Prettier laid out and hide the change. */
function replaceOnce(
	source: string,
	pattern: RegExp,
	replacement: string,
): string | null {
	if (!pattern.test(source)) return null;
	return source.replace(pattern, replacement);
}

function versionKeyEdit(
	source: string,
	previous: string,
	next: string,
): string | null {
	return replaceOnce(
		source,
		new RegExp(`^(\\s*"version":\\s*")${escape(previous)}(")`, 'm'),
		`$1${next}$2`,
	);
}

function specVersionEdit(
	source: string,
	previous: string,
	next: string,
): string | null {
	return replaceOnce(
		source,
		new RegExp(`^(specVersion:\\s*)${escape(previous)}(\\s*)$`, 'm'),
		`$1${next}$2`,
	);
}

function manifestRangeEdit(
	source: string,
	id: string,
	range: string,
): string | null {
	const entry = new RegExp(
		`(\\{[^{}]*"id":\\s*"${escape(id)}"[^{}]*"range":\\s*")([^"]*)(")`,
	);
	return replaceOnce(source, entry, `$1${range}$3`);
}

function specRangeEdit(
	source: string,
	id: string,
	range: string,
): string | null {
	const entry = new RegExp(
		`(-\\s*id:\\s*${escape(id)}\\s*\\n\\s*range:\\s*)(\\S+)`,
	);
	return replaceOnce(source, entry, `$1${range}`);
}

async function readOptional(path: string): Promise<string | null> {
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

export interface ModuleVersionBumpOptions {
	readonly id: string;
	readonly level: string;
	readonly apply: boolean;
}

export async function bumpModuleVersion(
	workspace: Workspace,
	options: ModuleVersionBumpOptions,
): Promise<CommandEnvelope> {
	if (!LEVELS.includes(options.level as ModuleVersionLevel))
		return failure(
			'USAGE_ERROR',
			`Use module version bump <id> <patch|minor|major> [--apply]; got "${options.level}".`,
		);
	const level = options.level as ModuleVersionLevel;
	const modules = await loadModules(workspace);
	const target = modules.find((module) => module.manifest.id === options.id);
	if (!target)
		return failure(
			'MODULE_NOT_FOUND',
			`No module "${options.id}" under the configured module roots.`,
		);
	if (await installerManaged(workspace, options.id))
		return failure(
			'MODULE_INSTALLER_MANAGED',
			`${options.id} is installed from a catalog; use module update instead of bumping it locally.`,
		);

	const previous = target.manifest.version;
	const next = incrementModuleVersion(previous, level);
	const spec = specDirectory(workspace);
	const writes = new Map<string, string>();
	const files: ModuleVersionEdit[] = [];
	const manual: string[] = [];
	const rel = (path: string) => relative(workspace.root, path);

	const manifestSource = await readFile(target.file, 'utf8');
	const manifestNext = versionKeyEdit(manifestSource, previous, next);
	if (!manifestNext)
		return failure(
			'MODULE_VERSION_UNEDITABLE',
			`${rel(target.file)} has no "version": "${previous}" line to rewrite.`,
		);
	writes.set(target.file, manifestNext);
	files.push({
		path: rel(target.file),
		change: `version ${previous} -> ${next}`,
	});

	const packagePath = join(target.root, 'package.json');
	const packageSource = await readOptional(packagePath);
	if (packageSource) {
		const edited = versionKeyEdit(packageSource, previous, next);
		if (edited) {
			writes.set(packagePath, edited);
			files.push({
				path: rel(packagePath),
				change: `version ${previous} -> ${next}`,
			});
		} else manual.push(`${rel(packagePath)}: version is not ${previous}`);
	}

	const specPath = join(target.root, spec, 'module.yaml');
	const specSource = await readOptional(specPath);
	if (specSource) {
		const edited = specVersionEdit(specSource, previous, next);
		if (edited) {
			writes.set(specPath, edited);
			files.push({
				path: rel(specPath),
				change: `specVersion ${previous} -> ${next}`,
			});
		} else if (!specVersionEdit(specSource, next, next))
			manual.push(
				`${rel(specPath)}: specVersion is neither ${previous} nor ${next}`,
			);
	}

	for (const dependent of modules) {
		if (dependent.manifest.id === options.id) continue;
		const dependency = dependent.manifest.dependencies.find(
			(entry) => entry.id === options.id,
		);
		if (!dependency) continue;
		const range = retargetModuleRange(dependency.range, next);
		if (range === null) {
			manual.push(
				`${rel(dependent.file)}: range "${dependency.range}" for ${options.id} excludes ${next}`,
			);
			continue;
		}
		if (range === dependency.range) continue;
		const source = await readFile(dependent.file, 'utf8');
		const edited = manifestRangeEdit(source, options.id, range);
		if (!edited) {
			manual.push(
				`${rel(dependent.file)}: dependency entry for ${options.id} not found as text`,
			);
			continue;
		}
		writes.set(dependent.file, edited);
		files.push({
			path: rel(dependent.file),
			change: `${options.id} ${dependency.range} -> ${range}`,
		});
		const dependentSpecPath = join(dependent.root, spec, 'module.yaml');
		const dependentSpec = await readOptional(dependentSpecPath);
		if (!dependentSpec) continue;
		const specEdited = specRangeEdit(dependentSpec, options.id, range);
		if (specEdited && specEdited !== dependentSpec) {
			writes.set(dependentSpecPath, specEdited);
			files.push({
				path: rel(dependentSpecPath),
				change: `${options.id} ${dependency.range} -> ${range}`,
			});
		} else if (
			!specEdited &&
			new RegExp(`id:\\s*${escape(options.id)}\\s*$`, 'm').test(dependentSpec)
		) {
			manual.push(
				`${rel(dependentSpecPath)}: dependency entry for ${options.id} not found as "- id" then "range" lines`,
			);
		}
	}

	if (options.apply)
		for (const [path, content] of writes) await writeFile(path, content);

	const report: ModuleVersionReport = {
		id: options.id,
		previous,
		next,
		applied: options.apply,
		files,
		manual,
	};
	return success(report, {
		evidence: files.map((file) => file.path),
		warnings: [
			...(options.apply
				? []
				: ['Dry run only. Pass --apply to write these files.']),
			...manual.map((entry) => `Needs a manual edit: ${entry}`),
		],
	});
}

export async function describeModuleVersion(
	workspace: Workspace,
	id: string,
): Promise<CommandEnvelope> {
	const modules = await loadModules(workspace);
	const target = modules.find((module) => module.manifest.id === id);
	if (!target)
		return failure(
			'MODULE_NOT_FOUND',
			`No module "${id}" under the configured module roots.`,
		);
	const dependents = modules.flatMap((module) => {
		const dependency = module.manifest.dependencies.find(
			(entry) => entry.id === id,
		);
		return dependency
			? [{ id: module.manifest.id, range: dependency.range }]
			: [];
	});
	return success({
		id,
		version: target.manifest.version,
		platformApi: target.manifest.platformApi ?? null,
		dependents,
	});
}
