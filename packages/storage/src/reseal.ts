import { KeyringError, type Keyring } from '@flowdular/kernel';
import {
	StorageError,
	storageObjectKey,
	type StorageObjectRef,
} from './contracts.ts';
import {
	readStoredObjectHeader,
	resealStoredObject,
	STORAGE_HEADER_PREFIX_BYTES,
} from './envelope.ts';
import type { ObjectStore } from './store.ts';

export interface StorageResealCount {
	readonly keyId: string;
	readonly objects: number;
}

export interface StorageResealReport {
	/** Key id every object should end on: the current key of the ring. */
	readonly currentKeyId: string;
	readonly counts: readonly StorageResealCount[];
	/** Objects on a retired key the ring still holds. */
	readonly stale: number;
	readonly resealed: number;
	/** Objects sealed under a key id this ring does not hold; left as they are. */
	readonly unknown: number;
	/** Objects that failed authentication under the key they name; left as they are. */
	readonly refused: number;
	/** References with no object behind them. */
	readonly missing: number;
}

export interface StorageResealOptions {
	readonly apply: boolean;
}

export interface StorageResealPort {
	/** Key id every re-seal writes: the current key of the ring. */
	readonly keyId: string;
	/**
	 * Re-seals every object of the batch that a retired key sealed, in place.
	 * The caller owns the inventory: an adapter cannot list, so the references
	 * come from the rows that name the objects. Without `apply` the headers are
	 * read and counted and nothing is written.
	 */
	reseal(
		objects: readonly StorageObjectRef[],
		options: StorageResealOptions,
	): Promise<StorageResealReport>;
}

/* A frame the port cannot parse is left exactly as the one it cannot open:
   the pass counts it and moves on, and the operator restores it. */
function corrupt(error: unknown): boolean {
	return error instanceof StorageError && error.code === 'OBJECT_CORRUPT';
}

export function createStorageResealer(
	store: ObjectStore,
	keyring: Keyring,
): StorageResealPort {
	return {
		keyId: keyring.keyId,
		async reseal(objects, options) {
			const counts = new Map<string, number>();
			let stale = 0;
			let resealed = 0;
			let unknown = 0;
			let refused = 0;
			let missing = 0;
			for (const reference of objects) {
				const key = storageObjectKey(reference);
				const prefix = await store.read(key, STORAGE_HEADER_PREFIX_BYTES);
				if (!prefix) {
					missing += 1;
					continue;
				}
				let keyId: string;
				try {
					keyId = readStoredObjectHeader(key, prefix).keyId;
				} catch (error) {
					if (corrupt(error)) {
						refused += 1;
						continue;
					}
					throw error;
				}
				counts.set(keyId, (counts.get(keyId) ?? 0) + 1);
				if (keyId === keyring.keyId) continue;
				if (!keyring.knows(keyId)) {
					unknown += 1;
					continue;
				}
				stale += 1;
				if (!options.apply) continue;
				const frame = await store.read(key);
				if (!frame) {
					missing += 1;
					continue;
				}
				let next;
				try {
					next = resealStoredObject(keyring, key, frame);
				} catch (error) {
					if (error instanceof KeyringError || corrupt(error)) {
						refused += 1;
						continue;
					}
					throw error;
				}
				await store.write(key, next.frame);
				resealed += 1;
			}
			return {
				currentKeyId: keyring.keyId,
				counts: [...counts]
					.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
					.map(([keyId, count]) => ({ keyId, objects: count })),
				stale,
				resealed,
				unknown,
				refused,
				missing,
			};
		},
	};
}
