import { Button, Icon, Tag } from '@coreloom/ui';
import type { TenantMember } from '@coreloom/module-auth';

export interface UsersTableProps {
	readonly users: readonly TenantMember[];
	readonly roleNames: ReadonlyMap<string, string>;
	readonly canManage: boolean;
	readonly onSelect: (accountId: string) => void;
}

export function UsersTable(props: UsersTableProps) @{
	<div class="ui-table-wrap">
		<table class="ui-table" aria-label="Tenant users">
			<thead>
				<tr>
					<th>User</th>
					<th>Role</th>
					<th>Status</th>
					<th class="num">Scopes</th>
					@if (props.canManage) {
						<th class="ui-table__actions"></th>
					}
				</tr>
			</thead>
			<tbody>
				@for (const user of props.users; key user.accountId) {
					<tr>
						<td>
							<span class="ui-cell">
								<b>{user.displayName}</b>
								<small>{user.email}</small>
							</span>
						</td>
						<td>
							<Tag tone={user.role === 'owner' ? 'ink' : 'neutral'}>
								{props.roleNames.get(user.role) ?? user.role}
							</Tag>
						</td>
						<td>
							<span class="ui-table__state">
								<Tag
									tone={user.status === 'active' ? 'success' : 'neutral'}
									dot
								>
									{user.status === 'active' ? 'Active' : 'Disabled'}
								</Tag>
								@if (user.passwordChangeRequired) {
									<small>Password reset pending</small>
								}
							</span>
						</td>
						<td class="num">{String(user.scopes.length)}</td>
						@if (props.canManage) {
							<td class="ui-table__actions">
								<Button
									size="sm"
									onClick={() => props.onSelect(user.accountId)}
								>
									<Icon name="user" size={14} />
									Manage
								</Button>
							</td>
						}
					</tr>
				}
			</tbody>
		</table>
	</div>
}
