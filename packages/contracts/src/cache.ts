/**
 * Optional, disposable acceleration for module reads. A cache value is never
 * authoritative state, a permission decision, a lock, or a durable job record.
 */
export interface CacheOperationOptions {
	readonly signal?: AbortSignal;
}

export interface CachePutOptions extends CacheOperationOptions {
	/** Required, positive, and bounded by the host. No immortal entries. */
	readonly ttlMs: number;
}

/** A handle already bound to one deployment, module, tenant, and generation. */
export interface CachePort {
	/** Null means a miss. An unavailable backend rejects, so callers can fall back. */
	get(key: string, options?: CacheOperationOptions): Promise<Uint8Array | null>;
	put(key: string, value: Uint8Array, options: CachePutOptions): Promise<void>;
	delete(key: string, options?: CacheOperationOptions): Promise<void>;
}

/** Created by the host from a module declaration and a trusted tenant context. */
export interface CacheScope {
	readonly deploymentId: string;
	readonly moduleId: string;
	readonly tenantId: string;
	/** A new generation makes old keys unreachable without scanning the backend. */
	readonly generation: string;
}

/** Host-only adapter seam. A future Redis adapter implements this interface. */
export interface CacheAdapter {
	readonly id: string;
	/** Every operation on the returned port is confined to this scope. */
	openScope(scope: CacheScope): CachePort;
	/** Drains in-flight work and closes connections; safe to call twice. */
	close(): Promise<void>;
}
