/** `system.modules.v1`: which composed modules are active in a workspace. */
export interface SystemModulesCapability {
	isActive(tenantId: string, moduleId: string): Promise<boolean>;
	/** Sorted ids of the composed modules active in the workspace. */
	activeIds(tenantId: string): Promise<readonly string[]>;
}
