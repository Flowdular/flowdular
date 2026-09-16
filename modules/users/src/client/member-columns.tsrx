import {
	CellNumber,
	CellStack,
	CellTag,
	CellText,
	CellTime,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import type { TenantMember } from '@flowdular/module-auth';

export function memberColumns(
	roleNames: ReadonlyMap<string, string>,
): readonly TableColumn<TenantMember>[] {
	return [
		/* The two keys the server sorts by are the two sortable columns, so a
   header click names the sort key as it is. */
		{
			key: 'displayName',
			header: t('users.table.user'),
			width: 'auto',
			value: (user) => user.displayName,
			cell: (user) => <CellText value={user.displayName} strong />,
		},
		{
			key: 'email',
			header: t('users.table.email'),
			width: 'auto',
			priority: 2,
			value: (user) => user.email,
			cell: (user) => <CellText value={user.email} />,
		},
		{
			key: 'role',
			header: t('users.table.role'),
			width: '140px',
			cell: (user) =>
				<CellTag
					tone={user.role === 'owner' ? 'ink' : 'neutral'}
					label={roleNames.get(user.role) ?? user.role}
				/>,
		},
		{
			key: 'status',
			header: t('users.table.status'),
			width: '200px',
			cell: (user) =>
				<CellStack
					primary={<CellTag
						tone={user.membershipStatus === 'active' ? 'success' : 'neutral'}
						dot
						label={user.membershipStatus === 'active'
							? t('users.status.active')
							: t('users.status.disabled')}
					/>}
					secondary={[
						user.status === 'disabled' ? t('users.status.blocked') : '',
						user.passwordChangeRequired
							? t('users.status.passwordResetPending')
							: '',
					].filter(Boolean).join(' · ')}
				/>,
		},
		{
			key: 'scopes',
			header: t('users.table.scopes'),
			width: '100px',
			numeric: true,
			priority: 3,
			cell: (user) => <CellNumber value={user.scopes.length} />,
		},
		/* No `value`: the server's sorted read has no keyset over created_at. */
		{
			key: 'createdAt',
			header: t('users.table.joined'),
			width: '140px',
			priority: 3,
			cell: (user) => <CellTime value={user.createdAt} kind="date" />,
		},
	];
}
