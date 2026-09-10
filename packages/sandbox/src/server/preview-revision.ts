import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PreviewModuleSource } from './preview-modules.ts';

/** Includes dependency sources and deletions, not only the newest entry mtime. */
export async function previewRevision(
	sources: readonly PreviewModuleSource[],
): Promise<string> {
	const hash = createHash('sha256');
	const file = async (path: string, name: string) => {
		try {
			const content = await readFile(path);
			hash.update(JSON.stringify([name, content.length]));
			hash.update(content);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	};
	const directory = async (path: string, prefix: string): Promise<void> => {
		const entries = await readdir(path, { withFileTypes: true }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return [];
				throw error;
			},
		);
		for (const entry of entries.sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			if (entry.name === 'node_modules' || entry.name === 'dist') continue;
			const name = prefix + '/' + entry.name;
			if (entry.isDirectory()) await directory(join(path, entry.name), name);
			else if (entry.isFile()) await file(join(path, entry.name), name);
		}
	};
	for (const source of sources) {
		hash.update(JSON.stringify([source.id, source.path]));
		await file(join(source.path, 'module.json'), 'module.json');
		await file(join(source.path, 'package.json'), 'package.json');
		await directory(join(source.path, 'src'), 'src');
		await directory(join(source.path, 'migrations'), 'migrations');
	}
	return hash.digest('hex');
}
