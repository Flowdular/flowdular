import {
	access,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ModuleSpec } from '@coreloom/contracts';
import { loadWorkspaceFormatter, type Formatter } from './format.ts';
import { packageSuffix, planScaffold } from './module-templates.ts';
import { findNamedFiles, validateFile, validators } from './validation.ts';
import {
	resolveExistingInside,
	resolveInside,
	type Workspace,
} from './workspace.ts';

export interface ScaffoldRequest {
	readonly id: string;
	readonly specPath: string;
	readonly apply: boolean;
}

export interface ScaffoldResult {
	readonly applied: boolean;
	/* False when the workspace has no Prettier to format the written files. */
	readonly formatted: boolean;
	readonly moduleDirectory: string;
	readonly files: readonly string[];
	/* Planned files that already existed and were left untouched. */
	readonly skipped: readonly string[];
}

/* Installed dependencies are not module sources. A directory that holds only a
   specification plus a dependency link is still an empty module. */
const IGNORED_ENTRIES = new Set(['node_modules', 'dist']);

/* Files another author may place before the scaffold runs: the specification
   itself and translations written alongside it. */
function ownedByAuthor(path: string): boolean {
	return path === 'spec/module.yaml' || path.startsWith('translations/');
}

async function listFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (IGNORED_ENTRIES.has(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(path)));
		else files.push(path);
	}
	return files.sort();
}

interface TargetState {
	readonly exists: boolean;
	readonly present: ReadonlySet<string>;
}

async function inspectTarget(
	workspaceRoot: string,
	moduleDirectory: string,
	specPath: string,
	specSource: string,
): Promise<TargetState> {
	try {
		await access(moduleDirectory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { exists: false, present: new Set() };
		}
		throw error;
	}
	const present = new Set(
		(await listFiles(moduleDirectory)).map((file) =>
			relative(moduleDirectory, file),
		),
	);
	const foreign = [...present].filter((path) => !ownedByAuthor(path));
	if (foreign.length > 0) {
		throw new Error(
			`Target module directory already exists: ${relative(workspaceRoot, moduleDirectory)}`,
		);
	}
	if (present.has('spec/module.yaml')) {
		const existingSpecPath = join(moduleDirectory, 'spec/module.yaml');
		const sameFile = resolve(specPath) === (await realpath(existingSpecPath));
		if (
			!sameFile &&
			(await readFile(existingSpecPath, 'utf8')) !== specSource
		) {
			throw new Error(
				`${relative(workspaceRoot, existingSpecPath)} holds a different specification than ${relative(workspaceRoot, specPath)}.`,
			);
		}
	}
	return { exists: true, present };
}

/* Every write is tracked so a failure midway leaves the directory exactly as it
   was found: nothing partial for the next attempt to trip over. */
async function writeScaffold(
	moduleDirectory: string,
	files: ReadonlyMap<string, string>,
	target: TargetState,
): Promise<void> {
	const written: string[] = [];
	const createdDirectories: string[] = [];
	try {
		for (const [path, source] of files) {
			if (target.present.has(path)) continue;
			const absolute = join(moduleDirectory, path);
			const created = await mkdir(dirname(absolute), { recursive: true });
			if (created) createdDirectories.push(created);
			await writeFile(absolute, source, { encoding: 'utf8', flag: 'wx' });
			written.push(absolute);
		}
	} catch (error) {
		if (!target.exists) {
			await rm(moduleDirectory, { recursive: true, force: true });
		} else {
			for (const file of written) await rm(file, { force: true });
			for (const directory of createdDirectories.reverse()) {
				await rm(directory, { recursive: true, force: true });
			}
		}
		throw error;
	}
}

export async function scaffoldModule(
	workspace: Workspace,
	request: ScaffoldRequest,
): Promise<ScaffoldResult> {
	if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(request.id)) {
		throw new Error(
			'Module id must use at least two lowercase dot-separated segments.',
		);
	}

	const specPath = await resolveExistingInside(
		workspace.root,
		request.specPath,
	);
	const specReport = await validateFile(specPath, validators.moduleSpec);
	if (!specReport.valid) {
		throw new Error(
			`Module specification is invalid: ${specReport.issues.map((issue) => issue.message).join('; ')}`,
		);
	}
	const specSource = await readFile(specPath, 'utf8');
	const spec = parseYaml(specSource) as ModuleSpec;
	if (spec.id !== request.id)
		throw new Error(
			`Specification id "${spec.id}" does not match "${request.id}".`,
		);
	if (spec.status !== 'approved')
		throw new Error(
			'A module can only be created from an approved specification.',
		);
	const existingManifests = (
		await findNamedFiles(workspace.root, 'module.json')
	).filter((path) => path.includes('/modules/'));
	for (const path of existingManifests) {
		const existing = JSON.parse(await readFile(path, 'utf8')) as {
			id?: string;
		};
		if (existing.id === request.id) {
			throw new Error(
				`Module id "${request.id}" is already registered by ${relative(workspace.root, path)}.`,
			);
		}
	}

	const moduleDirectory = resolveInside(
		workspace.root,
		join('modules', packageSuffix(request.id)),
	);
	const target = await inspectTarget(
		workspace.root,
		moduleDirectory,
		specPath,
		specSource,
	);
	const planned = planScaffold(spec, specSource);

	let formatted = false;
	if (request.apply) {
		const formatter = await loadWorkspaceFormatter(workspace.root);
		const files = formatter
			? await formatFiles(moduleDirectory, planned, formatter)
			: planned;
		formatted = formatter !== null;
		await writeScaffold(moduleDirectory, files, target);
	}

	const moduleRelative = relative(workspace.root, moduleDirectory);
	return {
		applied: request.apply,
		formatted,
		moduleDirectory: moduleRelative,
		files: [...planned.keys()].map((path) => join(moduleRelative, path)),
		skipped: [...planned.keys()]
			.filter((path) => target.present.has(path))
			.map((path) => join(moduleRelative, path)),
	};
}

async function formatFiles(
	moduleDirectory: string,
	files: ReadonlyMap<string, string>,
	formatter: Formatter,
): Promise<ReadonlyMap<string, string>> {
	const formatted = new Map<string, string>();
	for (const [path, source] of files) {
		formatted.set(
			path,
			await formatter.format(join(moduleDirectory, path), source),
		);
	}
	return formatted;
}
