import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StorageError } from './contracts.ts';
import type { ObjectStore } from './store.ts';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function notFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function unavailable(action: string, error: unknown): StorageError {
	return new StorageError(
		'STORAGE_UNAVAILABLE',
		`The local object store could not ${action}.`,
		{ cause: error },
	);
}

/**
 * Development and test only. The key segments cannot contain a separator, so
 * the object path stays inside the directory; production refuses this adapter
 * the way it refuses the embedded database.
 */
export function createLocalObjectStore(directory: string): ObjectStore {
	const pathOf = (key: string): string => join(directory, key);
	return {
		async write(key, frame) {
			const path = pathOf(key);
			/* A reader must never see a half-written frame, so the bytes land on a
			   neighbouring temporary name and the rename publishes them at once. */
			const temporary = `${path}.${randomBytes(8).toString('hex')}.part`;
			try {
				await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
				await writeFile(temporary, frame, { mode: FILE_MODE });
				await rename(temporary, path);
			} catch (error) {
				await rm(temporary, { force: true }).catch(() => undefined);
				throw unavailable(`write ${key}`, error);
			}
		},
		async read(key, maxBytes) {
			let handle;
			try {
				handle = await open(pathOf(key), 'r');
			} catch (error) {
				if (notFound(error)) return null;
				throw unavailable(`read ${key}`, error);
			}
			try {
				const size = (await handle.stat()).size;
				const length = maxBytes === undefined ? size : Math.min(maxBytes, size);
				const buffer = Buffer.allocUnsafe(length);
				if (length > 0) await handle.read(buffer, 0, length, 0);
				return buffer;
			} catch (error) {
				throw unavailable(`read ${key}`, error);
			} finally {
				await handle.close();
			}
		},
		async remove(key) {
			try {
				await unlink(pathOf(key));
				return true;
			} catch (error) {
				if (notFound(error)) return false;
				throw unavailable(`delete ${key}`, error);
			}
		},
		close: () => Promise.resolve(),
	};
}
