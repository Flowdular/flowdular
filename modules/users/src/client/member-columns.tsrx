import { Tag, type TableColumn } from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import type { TenantMember } from '@flowdular/module-auth';

export function memberColumns(
	roleNames: ReadonlyMap<string, string>,
): readonly TableColumn<TenantMember>[] {
	return [
		{
			key: 'user',
			header: t('users.table.user'),
			width: '32%',
			cell: (user) => <span class="ui-cell">
				<b>{user.displayName}</b>
				<small>{user.email}</small>
			</span>,
		},
		{
			key: 'role',
			header: t('users.table.role'),
			width: '18%',
			cell: (user) =>
				<Tag tone={user.role === 'owner' ? 'ink' : 'neutral'}>
					{roleNames.get(user.role) ?? user.role}
				</Tag>,
		},
		{
			key: 'status',
			header: t('users.table.status'),
			width: '28%',
			cell: (user) => <span class="ui-table__state">
				<Tag tone={user.status === 'active' ? 'success' : 'neutral'} dot>
					{user.status === 'active'
						? t('users.status.active')
						: t('users.status.disabled')}
				</Tag>
				{user.passwordChangeRequired
					? <small>{t('users.status.passwordResetPending')}</small>
					: null}
			</span>,
		},
		{
			key: 'scopes',
			header: t('users.table.scopes'),
			width: '12%',
			numeric: true,
			cell: (user) => new Intl.NumberFormat(activeLocale()).format(
				user.scopes.length,
			),
		},
	];
}
