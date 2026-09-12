import type { DataClassDeclaration } from '@flowdular/kernel';
import type { AccessService } from './access-service.ts';

/**
 * The one class access.core owns. Attestations are the evidence that someone
 * reviewed a workspace's access, so they are kept until a person deletes them:
 * no sweep, and no erase either, which makes an erasure certificate name the
 * class as not erasable rather than quietly removing the record that a review
 * happened. Export is supported, because a workspace export is what an auditor
 * asks for.
 *
 * The service arrives as a thunk because declaring happens while the platform
 * composes, before anything has opened a database.
 */
export function accessDataClasses(
	service: () => Promise<AccessService>,
): readonly DataClassDeclaration[] {
	return [
		{
			key: 'attestations',
			label: 'Access attestations',
			defaultRetentionDays: null,
			exportable: true,
			export: async (input) =>
				(await service()).exportAttestations(input.tenantId, input.sink),
		},
	];
}
