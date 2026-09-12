/**
 * The declaration contract lives in `@flowdular/kernel`: it is the platform
 * registry every module receives as `context.dataClasses`, not a service
 * audit.core hands out. These re-exports keep the names this module and its
 * consumers already import; a declaring module imports them from the kernel.
 */
export { DATA_CLASS_LIMITS } from '@flowdular/kernel';
export type {
	DataClassDeclaration,
	DataClassExportInput,
	DataClassExportSink,
	DataClassExportSummary,
	DataClassModuleEntry,
	DataClassSweepInput,
	PlatformDataClassRegistry,
} from '@flowdular/kernel';
