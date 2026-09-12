/**
 * What an adapter does, and all it does: move opaque frames. Validation, the
 * key layout, encryption, scanning and read tokens live in one place above it,
 * so a second adapter cannot weaken a rule by forgetting it.
 */
export interface ObjectStore {
	write(key: string, frame: Uint8Array): Promise<void>;
	/** `maxBytes` reads only the frame prefix, for a metadata-only read. */
	read(key: string, maxBytes?: number): Promise<Uint8Array | null>;
	/** False when the object was already absent, so deletion is idempotent. */
	remove(key: string): Promise<boolean>;
	close(): Promise<void>;
}
