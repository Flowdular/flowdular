import { sandboxDirectory } from './config.ts';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxSession } from './sessions.ts';

export interface PreviewModuleSource {
	readonly id: string;
	readonly directory: string;
	readonly path: string;
	readonly support: boolean;
}

export const PREVIEW_SUPPORT_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../../modules',
);
const IDENTIFIER = /^[a-z][a-z0-9-]*\.core$/;

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
	session: SandboxSession,
	supportRoot = PREVIEW_SUPPORT_ROOT,
): Promise<readonly PreviewModuleSource[]> {
	const draftRoot = join(
		sandboxDirectory(workspaceRoot),
		'sessions',
		session.id,
		'workspace/modules',
	);
	const drafts = new Map(session.modules.map((module) => [module.id, module]));
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
			: join(supportRoot, directory);
		if (!draft) {
			const physical = await realpath(path).catch(() => null);
			const root = await realpath(supportRoot);
			if (!physical?.startsWith(root + sep))
				throw new Error('PREVIEW_DEPENDENCY_UNAVAILABLE: ' + id);
		}
		const definition = await manifest(path, Boolean(draft));
		if (definition.id && definition.id !== id)
			throw new Error('PREVIEW_DEPENDENCY_ID_MISMATCH: ' + id);
		for (const dependency of definition.dependencies ?? [])
			await visit(dependency.id);
		visiting.delete(id);
		visited.add(id);
		ordered.push({ id, directory, path, support: !draft });
	};
	for (const module of session.modules) await visit(module.id);
	return ordered;
}
