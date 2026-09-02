import type { CapabilityDescriptor } from '@coreloom/cli-protocol';

export const capabilities: readonly CapabilityDescriptor[] = [
	{
		id: 'workspace.doctor',
		version: 1,
		summary:
			'Check the workspace, runtime, contracts, policies, and module registry.',
		risk: 'read',
		requiresApprovedSpec: false,
		supportsDryRun: false,
	},
	{
		id: 'spec.validate',
		version: 1,
		summary:
			'Validate platform and module specifications against their schemas.',
		risk: 'read',
		requiresApprovedSpec: false,
		supportsDryRun: false,
	},
	{
		id: 'blueprint.validate',
		version: 1,
		summary: 'Validate blueprint manifests and required guardrail files.',
		risk: 'read',
		requiresApprovedSpec: false,
		supportsDryRun: false,
	},
	{
		id: 'module.validate',
		version: 1,
		summary: 'Validate module manifests and check enabled module references.',
		risk: 'read',
		requiresApprovedSpec: false,
		supportsDryRun: false,
	},
	{
		id: 'migration.status',
		version: 1,
		summary:
			'Report the migration ledger of every module database: applied, adopted, pending, or mismatch.',
		risk: 'read',
		requiresApprovedSpec: false,
		supportsDryRun: false,
	},
	{
		id: 'migration.verify',
		version: 1,
		summary:
			'Check every module ledger against the checksums of the migrations in the workspace.',
		risk: 'read',
		requiresApprovedSpec: false,
		supportsDryRun: false,
	},
	{
		id: 'migration.apply.local',
		version: 1,
		summary:
			'Apply or adopt the outstanding migrations of one module against its local database.',
		risk: 'process',
		requiresApprovedSpec: false,
		supportsDryRun: true,
		localOnly: true,
	},
	{
		id: 'workspace.state.migrate',
		version: 1,
		summary:
			'Copy pre-Coreloom local databases and vault keys into .coreloom/data without deleting the source.',
		risk: 'destructive',
		requiresApprovedSpec: false,
		supportsDryRun: true,
		localOnly: true,
		confirmation: 'migrate-legacy-state',
	},
	{
		id: 'module.create',
		version: 1,
		summary:
			'Create a module from an approved specification and the locked module blueprint.',
		risk: 'workspace-write',
		requiresApprovedSpec: true,
		supportsDryRun: true,
	},
] as const;

export function capability(id: string): CapabilityDescriptor | undefined {
	return capabilities.find((entry) => entry.id === id);
}
