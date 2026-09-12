import type { DataClassDeclaration } from '@flowdular/kernel';
import type { DirectoryAdministrationService } from './directory-service.ts';

/**
 * Days a provisioning event is kept unless the workspace shortens the period.
 * The log is the evidence of what an identity provider changed in the
 * workspace, so it outlives the request that wrote it by an audit year rather
 * than by an operational window.
 */
export const PROVISIONING_EVENT_RETENTION_DAYS = 365;

/**
 * The classes directory.core owns. The provisioning log is the only one kept by
 * age: SCIM tokens, the user and group mappings and their memberships are the
 * provisioning configuration and the current picture of the directory, and a
 * period that removed them would break the next SCIM request rather than
 * retire history.
 *
 * The service arrives as a thunk because declaring happens while the platform
 * composes, before anything has opened a database.
 */
export function directoryDataClasses(
	administration: () => Promise<DirectoryAdministrationService>,
): readonly DataClassDeclaration[] {
	return [
		{
			key: 'provisioning-events',
			label: 'Provisioning log',
			defaultRetentionDays: PROVISIONING_EVENT_RETENTION_DAYS,
			exportable: true,
			sweep: async (input) =>
				(await administration()).sweepEvents(
					input.tenantId,
					input.cutoff,
					input.limit,
				),
			export: async (input) =>
				(await administration()).exportEvents(input.tenantId, input.sink),
		},
	];
}
