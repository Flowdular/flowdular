import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseProvider } from '@flowdular/database';
import type { PreviewModuleSource } from './preview-modules.ts';

export const PREVIEW_SEED_FILE = 'preview/seed.json';
export const PREVIEW_SEED_ENTRY = 'src/preview.ts';
export const MAX_PREVIEW_SEED_BYTES = 1024 * 1024;
const SEED_MARKER = 'preview-seeds.json';

/* What `seed()` in a draft's src/preview.ts receives: the preview workspace and
   account, the parsed preview/seed.json, and the preview's own database
   provider, the one the module's composition already writes through. */
export interface PreviewSeedContext {
	readonly tenantId: string;
	readonly accountId: string;
	readonly data: unknown;
	readonly databases: DatabaseProvider;
}

interface PreviewEntry {
	readonly seed?: unknown;
}

async function readRegular(
	modulePath: string,
	file: string,
): Promise<Buffer | null> {
	const path = join(modulePath, file);
	const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return null;
		throw error;
	});
	if (!info) return null;
	if (!info.isFile() || info.size > MAX_PREVIEW_SEED_BYTES) {
		throw new Error(
			`${file} must be a regular file of at most ${MAX_PREVIEW_SEED_BYTES} bytes.`,
		);
	}
	return readFile(path);
}

async function readMarker(path: string): Promise<Record<string, string>> {
	try {
		const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, string>)
			: {};
	} catch {
		return {};
	}
}

/* Seeds the ephemeral database once per content of preview/seed.json and
   src/preview.ts, after the generation started. A changed file seeds again, so
   seed() must be idempotent. Failures are reported per module and never stop
   the preview. */
export async function seedPreviewDrafts(input: {
	readonly modules: readonly PreviewModuleSource[];
	readonly revision: string;
	readonly dataPath: string;
	readonly context: Omit<PreviewSeedContext, 'data'>;
}): Promise<readonly string[]> {
	const markerPath = join(input.dataPath, SEED_MARKER);
	const marker = await readMarker(markerPath);
	const errors: string[] = [];
	for (const module of input.modules) {
		if (module.support) continue;
		try {
			const seedFile = await readRegular(module.path, PREVIEW_SEED_FILE);
			const entryFile = await readRegular(module.path, PREVIEW_SEED_ENTRY);
			if (!seedFile || !entryFile) continue;
			const digest = createHash('sha256')
				.update(seedFile)
				.update('\0')
				.update(entryFile)
				.digest('hex');
			if (marker[module.id] === digest) continue;
			let data: unknown;
			try {
				data = JSON.parse(seedFile.toString('utf8'));
			} catch (error) {
				throw new Error(
					`${PREVIEW_SEED_FILE} is not valid JSON: ${(error as Error).message}`,
				);
			}
			const entry = (await import(
				`${pathToFileURL(join(module.path, PREVIEW_SEED_ENTRY)).href}?revision=${input.revision}`
			)) as PreviewEntry;
			if (typeof entry.seed !== 'function') {
				throw new Error(
					`${PREVIEW_SEED_ENTRY} does not export a seed function, so ${PREVIEW_SEED_FILE} was not loaded.`,
				);
			}
			await entry.seed({ ...input.context, data });
			marker[module.id] = digest;
			await mkdir(input.dataPath, { recursive: true, mode: 0o700 });
			await writeFile(markerPath, JSON.stringify(marker), {
				encoding: 'utf8',
				mode: 0o600,
			});
		} catch (error) {
			errors.push(
				`${module.id}: the preview seed failed: ${
					error instanceof Error
						? error.message.slice(0, 400)
						: 'seed() threw a non-error value.'
				}`,
			);
		}
	}
	return errors;
}
