import type { DataClassDeclaration } from '@flowdular/kernel';
import type { MeteringService } from './metering-service.ts';

/** Days a bucket is kept unless the workspace shortens the period. */
export const BUCKET_RETENTION_DAYS = 400;

/**
 * The classes metering.core owns. Day buckets are the only rows kept by age:
 * limits and threshold records stay until the operator removes them, and the
 * idempotency claims travel with the buckets they belong to.
 *
 * The service arrives as a thunk because declaring happens while the platform
 * composes, before anything has opened a database.
 */
export function meteringDataClasses(
	service: () => Promise<MeteringService>,
): readonly DataClassDeclaration[] {
	return [
		{
			key: 'buckets',
			label: 'Usage buckets',
			defaultRetentionDays: BUCKET_RETENTION_DAYS,
			exportable: true,
			sweep: async (input) =>
				(await service()).sweepBuckets(
					input.tenantId,
					input.cutoff,
					input.limit,
				),
			export: async (input) =>
				(await service()).exportBuckets(input.tenantId, input.sink),
		},
	];
}
