import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { METERING_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'metering.navigation',
			label: 'Usage',
			href: '/metering-usage',
			order: 68,
			permission: METERING_PERMISSIONS.read,
		},
	],
	permissions: Object.values(METERING_PERMISSIONS),
} satisfies RegisteredModule;

export { METERING_PERMISSIONS } from './acl/permissions.ts';

/* The cross-module contract. A reporting module imports the identifier and the
   types from here and resolves the implementation through the capability
   registry; nothing else in this module is meant to be imported by another. */
export {
	METERING_METERS_CAPABILITY,
	METER_LIMIT_EXCEEDED,
	METER_LIMITS,
} from './domain/meters.ts';
export type {
	MeterCheckInput,
	MeterCheckResult,
	MeterDeclaration,
	MeterRecordInput,
	MeterRecordResult,
	MeterRegistry,
	MeterVerdict,
} from './domain/meters.ts';

export { METER_KINDS, METER_THRESHOLDS } from './domain/types.ts';
export type {
	Meter,
	MeterKind,
	MeterLimit,
	MeterLimitEvent,
	MeterThreshold,
	MeterThresholdNotice,
	MeterUsage,
	UsageBucket,
} from './domain/types.ts';

export { MeteringServiceError } from './services/service-error.ts';
