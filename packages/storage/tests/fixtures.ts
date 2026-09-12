import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKeyring, type Keyring } from '@flowdular/kernel';
import {
	storageConfigFromEnvironment,
	type StorageConfig,
} from '../src/config.ts';

export const TENANT = 'tenant-a';
export const MODULE = 'documents.core';

export function keyring(seed = 1, previous: readonly number[] = []): Keyring {
	return createKeyring({
		current: Buffer.alloc(32, seed),
		previous: previous.map((value) => Buffer.alloc(32, value)),
	});
}

export function pdf(text = 'receipt'): Uint8Array {
	return Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(text)]);
}

export function png(): Uint8Array {
	return Buffer.concat([
		Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
		Buffer.alloc(64, 3),
	]);
}

export async function workspace(): Promise<{
	readonly root: string;
	readonly directory: string;
	cleanup(): Promise<void>;
}> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-storage-'));
	return {
		root,
		directory: join(root, 'objects'),
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

export function localConfig(
	directory: string,
	overrides: NodeJS.ProcessEnv = {},
): StorageConfig {
	return storageConfigFromEnvironment(
		{
			NODE_ENV: 'test',
			FD_STORAGE_ADAPTER: 'local',
			FD_STORAGE_LOCAL_DIRECTORY: directory,
			...overrides,
		},
		directory,
	);
}

export async function collect(
	body: ReadableStream<Uint8Array>,
): Promise<Buffer> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	return Buffer.concat(chunks);
}
