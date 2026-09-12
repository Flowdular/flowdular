import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { AUDIT_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'audit.navigation',
			label: 'Data classes',
			href: '/audit-data-classes',
			order: 70,
			permission: AUDIT_PERMISSIONS.read,
		},
	],
	permissions: Object.values(AUDIT_PERMISSIONS),
} satisfies RegisteredModule;

export { AUDIT_PERMISSIONS } from './acl/permissions.ts';

/* The declaration contract is the platform's, not this module's: a declaring
   module receives it as context.dataClasses and imports the types from
   @flowdular/kernel. These re-exports keep the names a consumer already
   imports from here. */
export { DATA_CLASS_LIMITS } from './domain/data-classes.ts';
export type {
	DataClassDeclaration,
	DataClassExportInput,
	DataClassExportSink,
	DataClassExportSummary,
	DataClassModuleEntry,
	DataClassSweepInput,
	PlatformDataClassRegistry,
} from './domain/data-classes.ts';

export {
	AUDIT_EVENT_ACTIONS,
	AUDIT_REASONS,
	AUDIT_SEALED_MARKER,
	AUDIT_SUBJECT_TYPES,
	ERASURE_RUN_STATUSES,
	EXPORT_STATUSES,
	HOLD_SCOPE_KINDS,
	HOLD_STATUSES,
	RETENTION_MODES,
	SUBJECT_KEY_STATES,
	SWEEP_STATUSES,
} from './domain/types.ts';
export type {
	AuditChainAnchor,
	AuditDataClass,
	AuditErasureRun,
	AuditEvent,
	AuditExportRun,
	AuditLegalHold,
	AuditRegistryModule,
	AuditSubjectKey,
	AuditSubjectType,
	AuditSweepRun,
	ExportRunClassSummary,
	ExportRunExclusion,
	ErasureClassOutcome,
	ErasureRunStatus,
	ExportRunSummary,
	ExportStatus,
	HoldScopeKind,
	HoldStatus,
	LiftHoldInput,
	PlaceHoldInput,
	RetentionMode,
	SetRetentionInput,
	SubjectKeyState,
	SweepStatus,
} from './domain/types.ts';

export { AuditServiceError } from './services/service-error.ts';
