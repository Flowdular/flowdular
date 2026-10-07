import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PreviewModuleSource } from './preview-modules.ts';
import { readSpecText } from './spec.ts';

export const CATALOG_MODULE_ID = 'system.core';

async function manifestOf(path: string): Promise<object> {
	try {
		return JSON.parse(await readFile(join(path, 'module.json'), 'utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw error;
	}
}

/* system.core lists modules from flowdular.json and the manifests under its
   workspace root. The session root has neither and the draft workspace must
   not receive them, so the preview writes system.core a catalog workspace of
   its own under the session data directory: the manifests and specs of
   exactly the modules it composes, all enabled. A directory per revision keeps
   the live generation's catalog intact while the next one is written. */
export async function writePreviewCatalog(
	dataPath: string,
	revision: string,
	sources: readonly PreviewModuleSource[],
	liveRevision: string | undefined,
): Promise<string> {
	const parent = join(dataPath, 'preview-catalog');
	const existing = await readdir(parent).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return [];
			throw error;
		},
	);
	for (const entry of existing) {
		if (entry !== liveRevision)
			await rm(join(parent, entry), { recursive: true, force: true });
	}
	const root = join(parent, revision);
	await mkdir(root, { recursive: true });
	for (const source of sources) {
		const directory = join(root, 'modules', source.directory);
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, 'module.json'),
			JSON.stringify({ ...(await manifestOf(source.path)), id: source.id }),
		);
		const spec = await readSpecText(source.path);
		if (spec === null) continue;
		await mkdir(join(directory, 'spec'), { recursive: true });
		await writeFile(join(directory, 'spec/module.yaml'), spec);
	}
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({
			schemaVersion: 1,
			modules: { enabled: sources.map((source) => source.id) },
		}),
	);
	return root;
}
