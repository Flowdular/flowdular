import { defineListExport, type DefinedListExport } from '@flowdular/server';
import type { TenantMember } from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import { USER_PERMISSIONS } from '../acl/permissions.ts';
import { MEMBER_EXPORT_LIST_ID } from '../domain/lists.ts';

/**
 * The workspace's members as a CSV export. Every read goes through the auth
 * administration port, under the tenant of the principal the job was started
 * by and behind the permission the Members screen itself needs, so a file can
 * never carry a row that screen would not have shown.
 *
 * The walk is the port's own paged listing, so one page of L members costs one
 * statement over L rows and an export of M members reads M rows in total. Its
 * keyset is the account id, not the display name the unpaged roll is ordered
 * by: an account id never changes, so a member renamed while a long walk runs
 * cannot cross a page boundary and be written twice or skipped, and a member
 * removed mid-walk does not strand the cursor, because the next page is
 * whatever still sorts after the id it names.
 */
export function createMemberListExport(auth: AuthRuntime): DefinedListExport {
	return defineListExport<TenantMember>({
		id: MEMBER_EXPORT_LIST_ID,
		label: 'Members',
		permission: USER_PERMISSIONS.read,
		columns: [
			{ key: 'email', header: 'E-mail', value: (row) => row.email },
			{
				key: 'displayName',
				header: 'Display name',
				value: (row) => row.displayName,
			},
			{ key: 'role', header: 'Role', value: (row) => row.role },
			/* This workspace's own status for the member, which is what the
			   Members screen shows; the account-level block belongs to the
			   deployment operator and is not this workspace's to report. */
			{ key: 'status', header: 'Status', value: (row) => row.membershipStatus },
			{
				key: 'joinedAt',
				header: 'Joined at',
				value: (row) => new Date(row.createdAt),
			},
		],
		page: async (principal, cursor, limit) => {
			const page = await (
				await auth.service()
			).listTenantMembers(principal.tenantId, { cursor, limit });
			return { rows: page.members, nextCursor: page.nextCursor };
		},
	});
}
