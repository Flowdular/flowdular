export interface ModuleActivationRecord {
	readonly tenantId: string;
	readonly moduleId: string;
	readonly active: boolean;
	readonly changedBy: string;
	readonly changedAt: number;
}

/**
 * The per-workspace activation overrides, and nothing else: which modules are
 * composed comes from the workspace manifests, and a module without a row is
 * active.
 */
export interface ModuleActivationRepository {
	list(tenantId: string): Promise<readonly ModuleActivationRecord[]>;
	set(record: ModuleActivationRecord): Promise<void>;
}
