import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ModuleSource } from '@flowdular/contracts';
import { distributionAssert } from './module-artifact.ts';
import { loadModuleCatalog, type CatalogSource } from './module-catalog.ts';
import { resolveExistingInside, type Workspace } from './workspace.ts';

const exec = promisify(execFile);
const SOURCES_FILE = 'flowdular.module-sources.json';
const SOURCE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const COMMIT = /^[a-f0-9]{40}$/;

export interface NamedModuleSource {
	readonly name: string;
	readonly source: ModuleSource;
}

function sourcePath(workspace: Workspace): string {
	return join(workspace.root, SOURCES_FILE);
}

function validLocation(location: string): boolean {
	if (location.startsWith('https://')) {
		const url = new URL(location);
		return !url.username && !url.password && !url.search && !url.hash;
	}
	return location.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(location);
}

function validateSource(source: ModuleSource): void {
	distributionAssert(
		validLocation(source.location) && source.location.length <= 2048,
		'MODULE_SOURCE_INVALID',
		'Module source must be an HTTPS URL without credentials or a local path.',
	);
	if (source.kind === 'git') {
		distributionAssert(
			COMMIT.test(source.commit) &&
				source.catalogPath.length < 240 &&
				/^[a-zA-Z0-9_./-]+$/.test(source.catalogPath) &&
				!source.catalogPath
					.split('/')
					.some((part) => !part || part === '.' || part === '..') &&
				source.catalogPath.endsWith('.json'),
			'MODULE_SOURCE_INVALID',
			'Git sources need a 40-character commit and an in-repository catalog JSON path.',
		);
	} else
		distributionAssert(
			source.kind === 'catalog',
			'MODULE_SOURCE_INVALID',
			'Unsupported module source kind.',
		);
}

export async function readModuleSources(
	workspace: Workspace,
): Promise<readonly NamedModuleSource[]> {
	let raw: string;
	try {
		const info = await lstat(sourcePath(workspace));
		distributionAssert(
			info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024,
			'MODULE_SOURCE_INVALID',
			'Module source list is not a bounded regular file.',
		);
		raw = await readFile(sourcePath(workspace), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	const parsed = JSON.parse(raw) as {
		schemaVersion?: unknown;
		sources?: unknown;
	};
	distributionAssert(
		parsed?.schemaVersion === 1 &&
			Array.isArray(parsed.sources) &&
			parsed.sources.length <= 32,
		'MODULE_SOURCE_INVALID',
		'Invalid module source list.',
	);
	const names = new Set<string>();
	for (const entry of parsed.sources as NamedModuleSource[]) {
		distributionAssert(
			entry && SOURCE_NAME.test(entry.name) && !names.has(entry.name),
			'MODULE_SOURCE_INVALID',
			'Duplicate or invalid module source name.',
		);
		validateSource(entry.source);
		names.add(entry.name);
	}
	return parsed.sources as NamedModuleSource[];
}

export async function addModuleSource(
	workspace: Workspace,
	entry: NamedModuleSource,
	apply: boolean,
): Promise<{
	readonly sources: readonly NamedModuleSource[];
	readonly applied: boolean;
}> {
	distributionAssert(
		SOURCE_NAME.test(entry.name),
		'MODULE_SOURCE_INVALID',
		'Invalid module source name.',
	);
	validateSource(entry.source);
	return updateSources(workspace, apply, (current) => {
		distributionAssert(
			!current.some((item) => item.name === entry.name) && current.length < 32,
			'MODULE_SOURCE_EXISTS',
			'The source name already exists or the source limit was reached.',
		);
		return [...current, entry];
	});
}

export async function removeModuleSource(
	workspace: Workspace,
	name: string,
	apply: boolean,
) {
	return updateSources(workspace, apply, (current) => {
		distributionAssert(
			current.some((source) => source.name === name),
			'MODULE_SOURCE_MISSING',
			`Unknown module source ${name}.`,
		);
		return current.filter((source) => source.name !== name);
	});
}

async function updateSources(
	workspace: Workspace,
	apply: boolean,
	change: (
		current: readonly NamedModuleSource[],
	) => readonly NamedModuleSource[],
): Promise<{
	readonly sources: readonly NamedModuleSource[];
	readonly applied: boolean;
}> {
	if (!apply)
		return {
			sources: change(await readModuleSources(workspace)),
			applied: false,
		};
	const destination = sourcePath(workspace);
	const lock = destination + '.lock';
	try {
		await mkdir(lock);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST')
			distributionAssert(
				false,
				'MODULE_SOURCE_BUSY',
				'Module source configuration is being changed. Retry after the other command finishes.',
			);
		throw error;
	}
	try {
		const sources = change(await readModuleSources(workspace));
		const temp = destination + '.' + randomUUID() + '.tmp';
		await writeFile(
			temp,
			JSON.stringify({ schemaVersion: 1, sources }, null, '\t') + '\n',
			{ flag: 'wx' },
		);
		try {
			await rename(temp, destination);
		} finally {
			await rm(temp, { force: true });
		}
		return { sources, applied: true };
	} finally {
		await rm(lock, { recursive: true, force: true });
	}
}

async function git(
	directory: string,
	...arguments_: string[]
): Promise<string> {
	const { stdout } = await exec(
		'git',
		['-C', directory, '-c', 'core.hooksPath=/dev/null', ...arguments_],
		{
			timeout: 120_000,
			maxBuffer: 1024 * 1024,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		},
	);
	return stdout.trim();
}

/** The caller holds a Git checkout only for the duration of one plan or apply. */
export async function withModuleSource<T>(
	workspace: Workspace,
	source: ModuleSource,
	work: (catalog: CatalogSource) => Promise<T>,
): Promise<T> {
	validateSource(source);
	if (source.kind === 'catalog') {
		const location = source.location.startsWith('https://')
			? source.location
			: resolve(workspace.root, source.location);
		return work(await loadModuleCatalog(location));
	}
	const checkout = await mkdtemp(join(tmpdir(), 'flowdular-module-source-'));
	try {
		const location = source.location.startsWith('https://')
			? source.location
			: isAbsolute(source.location)
				? source.location
				: resolve(workspace.root, source.location);
		await git(checkout, 'init', '-q');
		await git(
			checkout,
			'fetch',
			'--no-tags',
			'--depth=1',
			location,
			source.commit,
		);
		await git(checkout, 'checkout', '-q', '--detach', 'FETCH_HEAD');
		distributionAssert(
			(await git(checkout, 'rev-parse', 'HEAD')) === source.commit,
			'MODULE_SOURCE_CHANGED',
			'Git did not resolve to the pinned commit.',
		);
		const catalogPath = await resolveExistingInside(
			checkout,
			source.catalogPath,
		);
		return await work(await loadModuleCatalog(catalogPath));
	} finally {
		await rm(checkout, { recursive: true, force: true });
	}
}
