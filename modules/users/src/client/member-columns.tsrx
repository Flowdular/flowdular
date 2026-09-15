import { Tag, type TableColumn } from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
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
			width: '20%',
			value: (user) => user.displayName,
			cell: (user) => <b>{user.displayName}</b>,
		},
		{
			key: 'email',
			header: t('users.table.email'),
			width: '22%',
			value: (user) => user.email,
			cell: (user) => <span>{user.email}</span>,
		},
		{
			key: 'role',
			header: t('users.table.role'),
			width: '14%',
			cell: (user) =>
				<Tag tone={user.role === 'owner' ? 'ink' : 'neutral'}>
					{roleNames.get(user.role) ?? user.role}
				</Tag>,
		},
		{
			key: 'status',
			header: t('users.table.status'),
			width: '22%',
			cell: (user) => <span class="ui-table__state">
				<Tag
					tone={user.membershipStatus === 'active' ? 'success' : 'neutral'}
					dot
				>
					{user.membershipStatus === 'active'
						? t('users.status.active')
						: t('users.status.disabled')}
				</Tag>
				{user.status === 'disabled'
					? <small>{t('users.status.blocked')}</small>
					: null}
				{user.passwordChangeRequired
					? <small>{t('users.status.passwordResetPending')}</small>
					: null}
			</span>,
		},
		{
			key: 'scopes',
			header: t('users.table.scopes'),
			width: '10%',
			numeric: true,
			cell: (user) => new Intl.NumberFormat(activeLocale()).format(
				user.scopes.length,
			),
		},
		/* No `value`: the server's sorted read has no keyset over created_at. */
		{
			key: 'createdAt',
			header: t('users.table.joined'),
			width: '12%',
			cell: (user) => new Intl.DateTimeFormat(activeLocale(), {
				dateStyle: 'medium',
			}).format(user.createdAt),
		},
	];
}
