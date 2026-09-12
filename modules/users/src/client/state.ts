import type { TenantMember } from '@flowdular/module-auth';
import { t } from '@flowdular/client/i18n';
import { cell, createStore } from 'segment-state';
import type { UserDirectory } from '../services/users-service.ts';
import { ApiError } from './api.ts';

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
		/* A started export outlives the click that started it, so it carries its
		   own line to the Exports screen instead of the notice every other action
		   shares and the next one overwrites. */
		exportStarted: false,
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

/* The membership route answers with stable codes; each one gets the sentence
   that says what to do instead, and anything else keeps the server message. */
export function membershipStatusMessage(error: unknown): string {
	const code = error instanceof ApiError ? error.code : '';
	if (code === 'SELF_TARGET') return t('users.membership.errorSelf');
	if (code === 'LAST_OWNER') return t('users.membership.errorLastOwner');
	if (code === 'OWNER_REQUIRED')
		return t('users.membership.errorOwnerRequired');
	if (code === 'ACCOUNT_NOT_FOUND') return t('users.membership.errorNotFound');
	return error instanceof Error && error.message !== ''
		? error.message
		: t('users.membership.error');
}
