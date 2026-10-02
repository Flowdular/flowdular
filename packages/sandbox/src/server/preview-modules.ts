import { sandboxDirectory } from './config.ts';
import { readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
	RESEARCH_MODULE_ID,
	assertRecordedAdapters,
	readSessionAdapters,
} from './recorded-adapters.ts';
import { readSpecText } from './spec.ts';

export interface PreviewModuleSource {
	readonly id: string;
	readonly directory: string;
	readonly path: string;
	readonly support: boolean;
}

export interface PreviewSessionSource {
	readonly id: string;
	readonly modules: readonly {
		readonly id: string;
		readonly directory: string;
	}[];
}

const IDENTIFIER = /^[a-z][a-z0-9-]*\.core$/;
export const DOCUMENTS_MODULE_ID = 'documents.core';

/* A generated application keeps its own modules in modules/ and the platform
   core modules in @flowdular/sdk. The isolated worker receives the SDK root
   from its parent before its file-read ceiling is applied. */
export async function previewSdkRoot(
	workspaceRoot: string,
): Promise<string | null> {
	const workerRoot =
		process.env.FD_INTERNAL_SANDBOX_PREVIEW_WORKER === '1'
			? process.env.FD_INTERNAL_SANDBOX_SDK_ROOT
			: undefined;
	const candidates = workerRoot
		? [workerRoot]
		: [
				join(workspaceRoot, 'platform/node_modules/@flowdular/sdk'),
				join(workspaceRoot, 'node_modules/@flowdular/sdk'),
			];
	for (const candidate of candidates) {
		let root: string;
		try {
			root = await realpath(candidate);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ERR_ACCESS_DENIED') continue;
			throw error;
		}
		const metadata = JSON.parse(
			await readFile(join(root, 'package.json'), 'utf8'),
		) as {
			name?: unknown;
		};
		if (metadata.name !== '@flowdular/sdk')
			throw new Error('PREVIEW_SDK_INVALID');
		return root;
	}
	return null;
}

async function supportPath(
	directory: string,
	roots: readonly string[],
): Promise<string | null> {
	for (const rootPath of roots) {
		const root = await realpath(rootPath).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return null;
				throw error;
			},
		);
		if (!root) continue;
		const path = join(rootPath, directory);
		const physical = await realpath(path).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return null;
				throw error;
			},
		);
		if (!physical) continue;
		if (!physical.startsWith(root + sep))
			throw new Error('PREVIEW_DEPENDENCY_UNAVAILABLE: ' + directory);
		return path;
	}
	return null;
}

/* A draft whose spec declares templates previews them through documents.core
   and the same renderer a deployment runs; nothing extra is seeded for it. The
   spec-schema gate stays the authority on the section's shape. */
async function declaresTemplates(
	modules: Iterable<{ readonly directory: string }>,
	draftRoot: string,
): Promise<boolean> {
	for (const module of modules) {
		const text = await readSpecText(join(draftRoot, module.directory));
		if (text === null) continue;
		try {
			const spec = parseYaml(text) as { templates?: unknown } | null;
			if (Array.isArray(spec?.templates) && spec.templates.length > 0) {
				return true;
			}
		} catch {
			continue;
		}
	}
	return false;
}

async function manifest(
	path: string,
	optional: boolean,
): Promise<{ id?: string; dependencies?: readonly { id: string }[] }> {
	try {
		return JSON.parse(await readFile(join(path, 'module.json'), 'utf8'));
	} catch (error) {
		if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT')
			return {};
		throw error;
	}
}

/** Dependencies are read-only platform sources, never copied into the draft or
 * included in delivery. Only explicitly declared dependencies are composed. */
export async function resolvePreviewModules(
	workspaceRoot: string,
	session: PreviewSessionSource,
	supportRoot?: string,
): Promise<readonly PreviewModuleSource[]> {
	const draftRoot = join(
		sandboxDirectory(workspaceRoot),
		'sessions',
		session.id,
		'workspace/modules',
	);
	const drafts = new Map(session.modules.map((module) => [module.id, module]));
	const sdkRoot = supportRoot ? null : await previewSdkRoot(workspaceRoot);
	const supportRoots = supportRoot
		? [supportRoot]
		: [
				join(workspaceRoot, 'modules'),
				...(sdkRoot ? [join(sdkRoot, 'modules')] : []),
			];
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const ordered: PreviewModuleSource[] = [];
	const visit = async (id: string): Promise<void> => {
		// The preview owns a separate auth runtime and its seeded identity.
		if (id === 'auth.core' || visited.has(id)) return;
		if (visiting.has(id)) throw new Error('PREVIEW_DEPENDENCY_CYCLE: ' + id);
		if (visited.size + visiting.size >= 64)
			throw new Error('PREVIEW_DEPENDENCY_LIMIT');
		visiting.add(id);
		const draft = drafts.get(id);
		if (!draft && !IDENTIFIER.test(id))
			throw new Error('PREVIEW_DEPENDENCY_UNAVAILABLE: ' + id);
		const directory = draft?.directory ?? id.slice(0, -5);
		if (!/^[a-z][a-z0-9-]*$/.test(directory))
			throw new Error('PREVIEW_MODULE_DIRECTORY_INVALID');
		const path = draft
			? join(draftRoot, directory)
			: await supportPath(directory, supportRoots);
		if (!path) throw new Error('PREVIEW_DEPENDENCY_UNAVAILABLE: ' + id);
		const definition = await manifest(path, Boolean(draft));
		if (definition.id && definition.id !== id)
			throw new Error('PREVIEW_DEPENDENCY_ID_MISMATCH: ' + id);
		for (const dependency of definition.dependencies ?? [])
			await visit(dependency.id);
		visiting.delete(id);
		visited.add(id);
		ordered.push({ id, directory, path, support: !draft });
	};
	/* A session whose spec declares research previews it through research.core on
	   recorded fixtures, and never composes one that names a live adapter. */
	const adapters = await readSessionAdapters(
		session.modules.map((module) => ({
			directory: module.directory,
			path: join(draftRoot, module.directory),
		})),
	);
	assertRecordedAdapters(adapters);
	if (adapters.research) await visit(RESEARCH_MODULE_ID);
	if (await declaresTemplates(drafts.values(), draftRoot)) {
		await visit(DOCUMENTS_MODULE_ID);
	}
	for (const module of session.modules) await visit(module.id);
	return ordered;
}
