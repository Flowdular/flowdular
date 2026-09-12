import { useEffect, useMemo, useState } from 'octane';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	EmptyState,
	Icon,
	Kpi,
	PageHeader,
	Pagination,
	SearchField,
	TableCard,
} from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import type { TenantMember } from '@flowdular/module-auth';
import { cell, createStore, useValue } from 'segment-state';
import {
	ApiError,
	assignMemberRole,
	createTenantUser,
	inviteTenantMember,
	loadTenantUsers,
	removeMember,
	renameMember,
	resetMemberPassword,
	revokeMemberSessions,
	setMemberScopes,
	setMembershipStatus,
	startListExport,
} from './api.ts';
import { MEMBER_EXPORT_LIST_ID } from '../domain/lists.ts';
import { memberColumns } from './member-columns.tsrx';
import { MemberDrawer } from './MemberDrawer.tsrx';
import {
	createUsersClientState,
	membershipStatusMessage,
	replaceMember,
} from './state.ts';
import { UserAccountForm } from './UserAccountForm.tsrx';
import { InviteMemberForm } from './InviteMemberForm.tsrx';

export interface UsersViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
	/** Whether the principal may start an export job; exports.core owns it. */
	readonly canExport: boolean;
}

const PAGE_SIZES = [10, 25, 50, 100];

/* memberColumns renders the cells; the screen supplies the value each column
   is ordered by, since the user column shows a name over an email. */
const SORT_VALUES: Readonly<
	Record<string, (user: TenantMember) => string | number>
> = {
	user: (user) => user.displayName,
	role: (user) => user.role,
	status: (user) => user.membershipStatus,
	scopes: (user) => user.scopes.length,
};

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
	const [inviteOpen, setInviteOpen] = useValue(usersState.state.inviteOpen);
	const [inviteSession, setInviteSession] = useValue(
		usersState.state.inviteSession,
	);
	const [selectedAccountId, setSelectedAccountId] = useValue(
		usersState.state.selectedAccountId,
	);
	const [exportStarted, setExportStarted] = useValue(
		usersState.state.exportStarted,
	);
	const confirm = useMemo(() => createStore({ remove: cell(false) }), []);
	const [removeOpen, setRemoveOpen] = useValue(confirm.state.remove);
	const [pageIndex, setPageIndex] = useState(0);
	const [pageSize, setPageSize] = useState(25);
	const selected =
		users.find((user) => user.accountId === selectedAccountId) ?? null;
	const columns = memberColumns(
		new Map(roles.map((role) => [role.key, role.name])),
	).map((column) => {
		const value = SORT_VALUES[column.key];
		return value ? { ...column, value } : column;
	});
	const owners = users.filter((user) => user.role === 'owner');
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const visible =
		term === ''
			? users
			: users.filter(
					(user) =>
						user.displayName.toLocaleLowerCase(locale).includes(term) ||
							user.email.toLocaleLowerCase(locale).includes(term),
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
				transaction.set(usersState.state.exportStarted, false);
				transaction.set(usersState.state.status, 'idle');
			}, 'users/loaded');
		} catch (loadError) {
			setError(message(loadError, t('users.error.load')));
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
		describeError: (error: unknown) => string = (error) => message(
			error,
			t('users.error.save'),
		),
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
			setError(describeError(mutationError));
			setStatus('idle');
		}
	};

	/* The membership route answers with the new status only, so the row it
   belongs to is patched here rather than reloaded. */
	const changeMembership = (
		member: TenantMember,
		next: 'active' | 'disabled',
	) => mutate(
		async () => ({
			...member,
			membershipStatus: (await setMembershipStatus(
				member.accountId,
				next,
				props.csrfToken,
			)).status,
		}),
		next === 'disabled'
			? t('users.notice.membershipDisabled')
			: t('users.notice.membershipEnabled'),
		membershipStatusMessage,
	);

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
			setError(message(createError, t('users.error.create')));
			setStatus('idle');
		}
	};

	const submitInvite = async (event: SubmitEvent) => {
		event.preventDefault();
		const element = event.currentTarget as HTMLFormElement;
		const form = new FormData(element);
		const email = formValue(form, 'email');
		setStatus('submitting');
		setError('');
		setNotice('');
		try {
			await inviteTenantMember(
				{ email, role: formValue(form, 'role') },
				props.csrfToken,
			);
			element.reset();
			setInviteSession((current) => current + 1);
			setInviteOpen(false);
			setNotice(t('users.invite.sent', { email }));
			setStatus('idle');
		} catch (inviteError) {
			setError(message(inviteError, t('users.invite.error')));
			setStatus('idle');
		}
	};

	/* exports.core answers as soon as the job is recorded, not when the file is
   written, so the screen reports that it started and points at the screen
   that hands it over. */
	const startExport = async () => {
		setStatus('submitting');
		setError('');
		setNotice('');
		try {
			await startListExport(MEMBER_EXPORT_LIST_ID, props.csrfToken);
			setExportStarted(true);
			setStatus('idle');
		} catch (exportError) {
			setError(message(exportError, t('users.export.error')));
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
			setError(message(removeError, t('users.error.remove')));
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('users.page.eyebrow')}
			title={t('users.page.title')}
			description={t('users.page.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('users.action.refresh')}
			</Button>
			@if (props.canExport) {
				<Button
					size="sm"
					disabled={status === 'denied' || status === 'submitting'}
					onClick={() => void startExport()}
				>
					<Icon name="download" size={14} />
					{t('users.export.action')}
				</Button>
			}
			@if (props.canManage) {
				<>
					<Button
						size="sm"
						disabled={status === 'denied'}
						onClick={() => {
							setError('');
							setNotice('');
							setInviteOpen(true);
						}}
					>
						<Icon name="plus" size={14} />
						{t('users.invite.action')}
					</Button>
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
						{t('users.action.newAccount')}
					</Button>
				</>
			}
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('users.denied.title')}>{t(
					'users.denied.members',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (error && !formOpen && !inviteOpen && !selected) {
					<Alert>{error}</Alert>
				}
				@if (notice && !selected) {
					<Alert tone="info">{notice}</Alert>
				}
				@if (exportStarted && !selected) {
					<Alert tone="info">
						{t('users.export.started')}
						{' '}
						<a href="/exports">{t('users.export.link')}</a>
					</Alert>
				}
				<TableCard
					title={t('users.table.title')}
					count={t('users.table.count', {
						owners: owners.length,
						accounts: users.length,
					})}
					search={<SearchField
						value={query}
						placeholder={t('users.search.placeholder')}
						label={t('users.search.label')}
						onInput={(value) => {
							setQuery(value);
							setPageIndex(0);
						}}
					/>}
					caption={t('users.table.caption')}
					columns={columns}
					rows={visible}
					rowKey={(user) => user.accountId}
					sorting
					onSortingChange={() => setPageIndex(0)}
					pagination={{ pageIndex, pageSize, onPageChange: setPageIndex }}
					after={<Pagination
						pageIndex={pageIndex}
						pageSize={pageSize}
						totalRows={visible.length}
						pageSizes={PAGE_SIZES}
						onPageChange={setPageIndex}
						onPageSizeChange={(size) => {
							setPageSize(size);
							setPageIndex(0);
						}}
						label={t('users.pagination.label')}
						previousLabel={t('users.pagination.previous')}
						nextLabel={t('users.pagination.next')}
						pageSizeLabel={t('users.pagination.size')}
						summary={(range) => t('users.pagination.summary', {
							page: range.pageIndex + 1,
							pages: range.pageCount,
							from: range.from,
							to: range.to,
							total: range.totalRows,
						})}
					/>}
					status={status === 'loading' && users.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('users.table.loading')}
					filtered={term !== ''}
					empty={{
						icon: 'users',
						title: t('users.table.emptyTitle'),
						hint: t('users.table.emptyHint'),
					}}
					emptyFiltered={{
						icon: 'users',
						title: t('users.table.emptyFilteredTitle'),
						hint: t('users.table.emptyFilteredHint'),
					}}
					actions={props.canManage
						? (user) => [
								{
									id: 'manage',
									label: t('users.action.manage'),
									icon: 'user',
									onSelect: () => openMember(user.accountId),
								},
							]
						: undefined}
					actionsLabel={t('users.table.actions')}
					noteIcon="shield"
					note={t('users.table.note')}
				/>
			</>
		}
		<Drawer
			open={formOpen}
			title={t('users.drawer.newTitle')}
			subtitle={t('users.drawer.newSubtitle')}
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
			open={inviteOpen}
			title={t('users.invite.title')}
			subtitle={t('users.invite.subtitle')}
			onClose={() => setInviteOpen(false)}
		>
			<InviteMemberForm
				key={'invite-form-' + inviteSession}
				roles={roles}
				canAssignOwner={actorIsOwner}
				busy={status === 'submitting'}
				error={inviteOpen ? error : ''}
				onCancel={() => setInviteOpen(false)}
				onSubmit={(event) => void submitInvite(event)}
			/>
		</Drawer>
		<Drawer
			open={selected !== null}
			title={selected?.displayName ?? t('users.drawer.member')}
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
						t('users.notice.nameSaved'),
					)}
					onAssignRole={(role) => void mutate(
						() => assignMemberRole(selected.accountId, role, props.csrfToken),
						t('users.notice.roleAssigned'),
					)}
					onSetScopes={(scopes) => void mutate(
						() => setMemberScopes(selected.accountId, scopes, props.csrfToken),
						t('users.notice.scopesSaved'),
					)}
					onSetMembershipStatus={(next) => void changeMembership(
						selected,
						next,
					)}
					onResetPassword={(temporaryPassword) => void mutate(
						() => resetMemberPassword(
							selected.accountId,
							temporaryPassword,
							props.csrfToken,
						),
						t('users.notice.passwordSet'),
					)}
					onRevokeSessions={() => void mutate(async () => {
						const revoked = await revokeMemberSessions(
							selected.accountId,
							props.csrfToken,
						);
						setNotice(t('users.notice.sessionsCount', { count: revoked }));
						return null;
					}, t('users.notice.sessionsEnded'))}
					onRemove={() => setRemoveOpen(true)}
					onClose={closeMember}
				/>
			}
		</Drawer>
		<ConfirmDialog
			open={removeOpen}
			title={t('users.remove.title')}
			confirmLabel={t('users.member.remove')}
			busy={status === 'submitting'}
			onConfirm={() => void remove()}
			onCancel={() => setRemoveOpen(false)}
		>{t('users.remove.description', {
			name: selected?.displayName ?? t('users.remove.fallbackName'),
		})}</ConfirmDialog>
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
		label={t('users.widget.label')}
		value={status === 'loading'
			? '…'
			: new Intl.NumberFormat(activeLocale()).format(users.length)}
		note={t('users.widget.note')}
		href="/users"
		linkLabel={t('users.widget.link')}
	/>
}

/* Dashboard setup step; the shell no longer hardcodes module links. */
export function UsersSetupStep() @{
	<a class="dash-step" href="/users">
		<span>
			<Icon name="users" size={16} />
		</span>
		<strong>{t('users.setup.title')}</strong>
		<small>{t('users.setup.description')}</small>
	</a>
}
