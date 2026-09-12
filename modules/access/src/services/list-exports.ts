import { randomBytes } from 'node:crypto';
import {
	decodeCursor,
	defineListExport,
	encodeCursor,
	type DefinedListExport,
} from '@flowdular/server';
import {
	ACCESS_LIMITS,
	type AccessAttestation,
	type AccessReviewMember,
	type AttestationPosition,
} from '../domain/types.ts';
import { ACCESS_PERMISSIONS } from '../acl/permissions.ts';
import type { AccessService } from './access-service.ts';

/**
 * exports.core's public registry. Only the identifier couples access.core to
 * that module: the shape is declared here, so a deployment without exports.core
 * composes exactly the same and registers nothing.
 */
export const EXPORT_LISTS_CAPABILITY = 'exports.lists.v1';

export interface ExportListRegistry {
	register(moduleId: string, exports: readonly DefinedListExport[]): void;
}

/**
 * The two lists access.core offers a file of. The review is a live read walked
 * by account id through the uncapped member page, so a workspace larger than
 * the review's own listing bound exports every member rather than the first
 * page of them, and a member renamed or removed mid-export cannot be written
 * twice or dropped. The attestation ledger is append-only, so its walk can
 * never skew at all.
 */
export function accessListExports(
	service: () => Promise<AccessService>,
): readonly DefinedListExport[] {
	/* Module-owned and never stored: an export cursor names a position in one
	   workspace's own walk and a restart costs the job its first page. */
	const secret = randomBytes(32);

	const review = defineListExport<AccessReviewMember>({
		id: 'access.core.review',
		label: 'Access review',
		permission: ACCESS_PERMISSIONS.read,
		columns: [
			{ key: 'member', header: 'Member', value: (row) => row.displayName },
			{ key: 'email', header: 'E-mail', value: (row) => row.email },
			{ key: 'role', header: 'Role', value: (row) => row.role },
			{
				key: 'accountStatus',
				header: 'Account status',
				value: (row) => row.accountStatus,
			},
			{
				key: 'membershipStatus',
				header: 'Workspace status',
				value: (row) => row.membershipStatus,
			},
			{ key: 'scopes', header: 'Scopes', value: (row) => row.scopeCount },
			{
				key: 'extraScopes',
				header: 'Beyond the role',
				value: (row) => row.extraScopes.join(' '),
			},
		],
		page: async (principal, cursor, limit) => {
			const page = await (
				await service()
			).memberPage(
				principal.tenantId,
				cursor,
				Math.min(limit, ACCESS_LIMITS.memberPage),
			);
			return { rows: page.members, nextCursor: page.nextCursor };
		},
	});

	const attestations = defineListExport<AccessAttestation>({
		id: 'access.core.attestations',
		label: 'Access attestations',
		permission: ACCESS_PERMISSIONS.read,
		columns: [
			{
				key: 'periodFrom',
				header: 'Period from',
				value: (row) => row.periodFrom,
			},
			{ key: 'periodTo', header: 'Period to', value: (row) => row.periodTo },
			{
				key: 'reviewer',
				header: 'Reviewer',
				value: (row) => row.reviewerLabel,
			},
			{ key: 'members', header: 'Members', value: (row) => row.memberCount },
			{
				key: 'activeMembers',
				header: 'Active members',
				value: (row) => row.activeMemberCount,
			},
			{ key: 'roles', header: 'Roles', value: (row) => row.roleCount },
			{
				key: 'extraScopes',
				header: 'Beyond a role',
				value: (row) => row.extraScopeCount,
			},
			{ key: 'tokens', header: 'API tokens', value: (row) => row.tokenCount },
			{
				key: 'providers',
				header: 'Identity providers',
				value: (row) => row.providerCount,
			},
			{ key: 'note', header: 'Note', value: (row) => row.note },
			{
				key: 'recordedAt',
				header: 'Recorded at',
				value: (row) => new Date(row.createdAt),
			},
		],
		page: async (principal, cursor, limit) => {
			let after: AttestationPosition | null = null;
			if (cursor !== null) {
				const value = decodeCursor(cursor, secret);
				if (
					!Number.isSafeInteger(value.createdAt) ||
					typeof value.id !== 'string'
				) {
					throw new Error('The export cursor is not a ledger position.');
				}
				after = { createdAt: value.createdAt as number, id: value.id };
			}
			/* The ledger pages at its own ceiling; a page smaller than the one the
			   job asked for is the contract, a page larger would break it. */
			const page = await (
				await service()
			).attestations(principal.tenantId, {
				limit: Math.min(limit, ACCESS_LIMITS.attestationLimit),
				after,
			});
			return {
				rows: page.items,
				nextCursor:
					page.next === null ? null : encodeCursor({ ...page.next }, secret),
			};
		},
	});

	return [review, attestations];
}
