import type { TenantMember } from '@flowdular/module-auth';
import { cell, createStore } from 'segment-state';
import type { UserDirectory } from '../services/users-service.ts';

export type UsersStatus =
	| 'idle'
	| 'loading'
	| 'submitting'
	| 'denied'
	| 'error';

export function createUsersClientState() {
	const store = createStore({
		users: cell<readonly TenantMember[]>([]),
		roles: cell<UserDirectory['roles']>([]),
		grantableScopes: cell<readonly string[]>([]),
		actor: cell<UserDirectory['actor'] | null>(null),
		passwordMinLength: 12,
		query: '',
		formOpen: false,
		formSession: 0,
		inviteOpen: false,
		inviteSession: 0,
		selectedAccountId: cell<string | null>(null),
		status: cell<UsersStatus>('idle'),
		error: '',
		notice: '',
	});
	return { store, state: store.state };
}

export type UsersClientState = ReturnType<typeof createUsersClientState>;

export function replaceMember(
	users: readonly TenantMember[],
	member: TenantMember,
): readonly TenantMember[] {
	const others = users.filter((user) => user.accountId !== member.accountId);
	return [...others, member].sort((left, right) =>
		left.displayName.localeCompare(right.displayName),
	);
}
