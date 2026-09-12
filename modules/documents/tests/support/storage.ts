import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Keyring } from '@flowdular/kernel';
import {
	createStorageKeyring,
	createStoragePort,
	storageConfigFromEnvironment,
	type StoragePort,
	type StorageScanner,
} from '@flowdular/storage';

export interface TestStorage {
	readonly port: StoragePort;
	/** The ring behind the port, so a test can open a read token itself. */
	readonly keyring: Keyring;
	readonly directory: string;
	readonly maxObjectBytes: number;
	/** Every object of every workspace, so a case starts from an empty store. */
	clear(): Promise<void>;
	/** Object keys currently in the store, workspace prefix first. */
	keys(): Promise<readonly string[]>;
	dispose(): Promise<void>;
}

export interface TestStorageOptions {
	readonly scanner?: StorageScanner;
	readonly clock?: () => Date;
	readonly maxObjectBytes?: number;
}

/* The suite exercises the real port, so every limit, the magic byte check, the
   encryption and the read token are the deployment's own code; only the
   directory and the scanner are the test's. */
export async function openTestStorage(
	options: TestStorageOptions = {},
): Promise<TestStorage> {
	const directory = await mkdtemp(join(tmpdir(), 'flowdular-documents-'));
	const maxObjectBytes = options.maxObjectBytes ?? 4_096;
	const environment = {
		NODE_ENV: 'test',
		FD_STORAGE_ADAPTER: 'local',
		FD_STORAGE_LOCAL_DIRECTORY: directory,
		FD_STORAGE_MAX_OBJECT_BYTES: String(maxObjectBytes),
	};
	const keyring = createStorageKeyring(environment, directory);
	const port = createStoragePort(
		storageConfigFromEnvironment(environment, directory),
		{
			keyring,
			...(options.scanner ? { scanner: options.scanner } : {}),
			...(options.clock ? { clock: options.clock } : {}),
		},
	);
	return {
		port,
		keyring,
		directory,
		maxObjectBytes,
		async clear() {
			await rm(directory, { recursive: true, force: true });
			await mkdir(directory, { recursive: true, mode: 0o700 });
		},
		async keys() {
			const entries = await readdir(directory, {
				recursive: true,
				withFileTypes: true,
			});
			return entries
				.filter((entry) => entry.isFile())
				.map((entry) =>
					join(entry.parentPath, entry.name).slice(directory.length + 1),
				)
				.sort();
		},
		async dispose() {
			await port.dispose();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

/** The byte sequence the test scanner treats as malware. */
export const INFECTED_MARKER = 'FLOWDULAR-TEST-INFECTED';

/**
 * A scanner whose verdict is in the bytes, so one port serves the clean and the
 * infected case in one file without a mutable switch between tests.
 */
export const markerScanner: StorageScanner = {
	async scan(body) {
		const chunks: Uint8Array[] = [];
		const reader = body.getReader();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) chunks.push(value);
		}
		const text = Buffer.concat(chunks).toString('latin1');
		return { verdict: text.includes(INFECTED_MARKER) ? 'infected' : 'clean' };
	},
};
