import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	EmptyState,
	Icon,
	Kpi,
	PageHeader,
	SearchField,
} from '@coreloom/ui';
import type { TenantMember } from '@coreloom/module-auth';
import { cell, createStore, useValue } from 'segment-state';
import {
	ApiError,
	assignMemberRole,
	createTenantUser,
	loadTenantUsers,
	removeMember,
	renameMember,
	resetMemberPassword,
	revokeMemberSessions,
	setMemberScopes,
	setMemberStatus,
} from './api.ts';
import { MemberDrawer } from './MemberDrawer.tsrx';
import { createUsersClientState, replaceMember } from './state.ts';
import { UserAccountForm } from './UserAccountForm.tsrx';
import { UsersTable } from './UsersTable.tsrx';

export interface UsersViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

function formValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export function UsersView(props: UsersViewProps) @{
	const usersState = useMemo(() => createUsersClientState(), []);
	const [users] = useValue(usersState.state.users);
	const [roles] = useValue(usersState.state.roles);
	const [grantableScopes] = useValue(usersState.state.grantableScopes);
	const [actor] = useValue(usersState.state.actor);
	const [passwordMinLength] = useValue(usersState.state.passwordMinLength);
	const actorIsOwner = actor?.role === 'owner';
	const [status, setStatus] = useValue(usersState.state.status);
	const [error, setError] = useValue(usersState.state.error);
	const [notice, setNotice] = useValue(usersState.state.notice);
	const [query, setQuery] = useValue(usersState.state.query);
	const [formOpen, setFormOpen] = useValue(usersState.state.formOpen);
	const [formSession, setFormSession] = useValue(usersState.state.formSession);
	const [selectedAccountId, setSelectedAccountId] = useValue(
		usersState.state.selectedAccountId,
	);
	const confirm = useMemo(() => createStore({ remove: cell(false) }), []);
	const [removeOpen, setRemoveOpen] = useValue(confirm.state.remove);
	const selected =
		users.find((user) => user.accountId === selectedAccountId) ?? null;
	const roleNames = new Map(roles.map((role) => [role.key, role.name]));
	const owners = users.filter((user) => user.role === 'owner');
	const term = query.trim().toLocaleLowerCase('en-US');
	const visible =
		term === ''
			? users
			: users.filter(
					(user) =>
						user.displayName.toLocaleLowerCase('en-US').includes(term) ||
							user.email.toLocaleLowerCase('en-US').includes(term),
				);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const directory = await loadTenantUsers();
			usersState.store.act((transaction) => {
				transaction.set(usersState.state.users, directory.users);
				transaction.set(usersState.state.roles, directory.roles);
				transaction.set(
					usersState.state.grantableScopes,
					directory.grantableScopes,
				);
				transaction.set(usersState.state.actor, directory.actor);
				transaction.set(
					usersState.state.passwordMinLength,
					directory.passwordMinLength,
				);
				transaction.set(usersState.state.status, 'idle');
			}, 'users/loaded');
		} catch (loadError) {
			setError(message(loadError, 'Could not load users.'));
			setStatus(
				loadError instanceof ApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	/* Every member action follows the same shape: mark busy, call, replace the
   row, report. Failures stay inside the drawer next to the control. */
	const mutate = async (
		run: () => Promise<TenantMember | null>,
		done: string,
	) => {
		setStatus('submitting');
		setError('');
		setNotice('');
		try {
			const member = await run();
			if (member) {
				usersState.store.act(
					(transaction) => transaction.set(
						usersState.state.users,
						replaceMember(users, member),
					),
					'users/member-updated',
				);
			}
			setNotice(done);
			setStatus('idle');
		} catch (mutationError) {
			setError(message(mutationError, 'The change could not be saved.'));
			setStatus('idle');
		}
	};

	const submitCreate = async (event: SubmitEvent) => {
		event.preventDefault();
		const element = event.currentTarget as HTMLFormElement;
		const form = new FormData(element);
		setStatus('submitting');
		setError('');
		try {
			const user = await createTenantUser(
				{
					displayName: formValue(form, 'displayName'),
					email: formValue(form, 'email'),
					password: formValue(form, 'password'),
					role: formValue(form, 'role'),
				},
				props.csrfToken,
			);
			usersState.store.act(
				(transaction) => transaction.set(
					usersState.state.users,
					replaceMember(users, user),
				),
				'users/created',
			);
			element.reset();
			setFormSession((current) => current + 1);
			setFormOpen(false);
			setStatus('idle');
		} catch (createError) {
			setError(message(createError, 'Could not create the user.'));
			setStatus('idle');
		}
	};

	const openMember = (accountId: string) => {
		setError('');
		setNotice('');
		setSelectedAccountId(accountId);
	};

	const closeMember = () => {
		setSelectedAccountId(null);
		setRemoveOpen(false);
		setError('');
		setNotice('');
	};

	const remove = async () => {
		if (!selected) return;
		const accountId = selected.accountId;
		setRemoveOpen(false);
		setStatus('submitting');
		setError('');
		try {
			await removeMember(accountId, props.csrfToken);
			usersState.store.act((transaction) => {
				transaction.set(
					usersState.state.users,
					users.filter((user) => user.accountId !== accountId),
				);
				transaction.set(usersState.state.selectedAccountId, null);
				transaction.set(usersState.state.status, 'idle');
			}, 'users/removed');
		} catch (removeError) {
			setError(message(removeError, 'Could not remove the member.'));
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow="Administration"
			title="Users"
			description="Accounts, roles, and scopes inside the active workspace."
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				Refresh
			</Button>
			@if (props.canManage) {
				<Button
					size="sm"
					variant="primary"
					disabled={status === 'denied'}
					onClick={() => {
						setError('');
						setFormOpen(true);
					}}
				>
					<Icon name="plus" size={14} />
					New account
				</Button>
			}
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title="Access denied">
					Reading the user directory needs the users.members.read scope.
				</EmptyState>
			</section>
		} @else {
			<>
				@if (error && !formOpen && !selected) {
					<Alert>{error}</Alert>
				}
				<section class="ui-card">
					<div class="ui-card__head">
						<span class="ui-card__title">
							Members
							<small>
								{owners.length + ' owners · ' + users.length + ' accounts'}
							</small>
						</span>
						<SearchField
							value={query}
							placeholder="Filter by name or email"
							label="Filter members"
							onInput={setQuery}
						/>
					</div>
					@if (status === 'loading' && users.length === 0) {
						<p class="ui-table__empty">Loading tenant accounts…</p>
					} @else if (visible.length === 0) {
						<EmptyState
							icon="users"
							title={term === '' ? 'No accounts yet' : 'No matching accounts'}
						>
							{term === ''
								? 'Create the first account for this workspace.'
								: 'No account in this workspace matches the current filter.'}
						</EmptyState>
					} @else {
						<UsersTable
							users={visible}
							roleNames={roleNames}
							canManage={props.canManage}
							onSelect={openMember}
						/>
					}
					<p class="ui-note">
						<Icon name="shield" size={14} />
						<span>
							Roles decide what an account may reach. Owners administer the
							workspace; every other role carries exactly the scopes it lists.
						</span>
					</p>
				</section>
			</>
		}
		<Drawer
			open={formOpen}
			title="New account"
			subtitle="Direct workspace access"
			onClose={() => setFormOpen(false)}
		>
			<UserAccountForm
				key={'account-form-' + formSession}
				roles={roles}
				canAssignOwner={actorIsOwner}
				passwordMinLength={passwordMinLength}
				busy={status === 'submitting'}
				error={formOpen ? error : ''}
				onCancel={() => setFormOpen(false)}
				onSubmit={(event) => void submitCreate(event)}
			/>
		</Drawer>
		<Drawer
			open={selected !== null}
			title={selected?.displayName ?? 'Member'}
			subtitle={selected?.email ?? ''}
			width="lg"
			onClose={closeMember}
		>
			@if (selected) {
				<MemberDrawer
					member={selected}
					roles={roles}
					grantableScopes={grantableScopes}
					isSelf={selected.accountId === actor?.accountId}
					actorIsOwner={actorIsOwner}
					passwordMinLength={passwordMinLength}
					busy={status === 'submitting'}
					error={error}
					notice={notice}
					onRename={(displayName) => void mutate(
						() => renameMember(
							selected.accountId,
							displayName,
							props.csrfToken,
						),
						'Display name saved.',
					)}
					onAssignRole={(role) => void mutate(
						() => assignMemberRole(selected.accountId, role, props.csrfToken),
						'Role assigned.',
					)}
					onSetScopes={(scopes) => void mutate(
						() => setMemberScopes(selected.accountId, scopes, props.csrfToken),
						'Scopes saved.',
					)}
					onSetStatus={(next) => void mutate(
						() => setMemberStatus(selected.accountId, next, props.csrfToken),
						next === 'disabled' ? 'Account disabled.' : 'Account enabled.',
					)}
					onResetPassword={(temporaryPassword) => void mutate(
						() => resetMemberPassword(
							selected.accountId,
							temporaryPassword,
							props.csrfToken,
						),
						'Temporary password set. The member must change it at sign-in.',
					)}
					onRevokeSessions={() => void mutate(async () => {
						const revoked = await revokeMemberSessions(
							selected.accountId,
							props.csrfToken,
						);
						setNotice(revoked + ' session(s) ended.');
						return null;
					}, 'Sessions ended.')}
					onRemove={() => setRemoveOpen(true)}
					onClose={closeMember}
				/>
			}
		</Drawer>
		<ConfirmDialog
			open={removeOpen}
			title="Remove this member?"
			confirmLabel="Remove member"
			busy={status === 'submitting'}
			onConfirm={() => void remove()}
			onCancel={() => setRemoveOpen(false)}
		>
			{(selected?.displayName ?? 'The member') +
				' loses access to this workspace immediately. Sessions and API tokens for this membership are revoked.'}
		</ConfirmDialog>
	</div>
}

export function UsersDashboardWidget() @{
	const widgetState = useMemo(() => createUsersClientState(), []);
	const [users] = useValue(widgetState.state.users);
	const [status, setStatus] = useValue(widgetState.state.status);
	useEffect(() => {
		setStatus('loading');
		void loadTenantUsers().then((directory) => {
			widgetState.store.act(
				(transaction) => transaction.set(
					widgetState.state.users,
					directory.users,
				),
				'users/widget-loaded',
			);
		}).catch(() => undefined).finally(() => setStatus('idle'));
	}, []);
	<Kpi
		label="Team"
		value={status === 'loading' ? '…' : String(users.length)}
		note="Accounts with access to the current organization."
		href="/users"
		linkLabel="Manage users"
	/>
}

/* Dashboard setup step; the shell no longer hardcodes module links. */
export function UsersSetupStep() @{
	<a class="dash-step" href="/users">
		<span>
			<Icon name="users" size={16} />
		</span>
		<strong>Invite your team</strong>
		<small>Accounts, roles, and scoped access</small>
	</a>
}
