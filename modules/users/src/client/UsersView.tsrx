import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	EmptyState,
	Filters,
	Icon,
	Kpi,
	PageHeader,
	Pagination,
	SearchField,
	Select,
	TableCard,
	ToastHost,
	toasts,
	type TableSort,
} from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import type { TenantMember } from '@flowdular/module-auth';
import { cell, createStore, useValue } from 'segment-state';
import {
	ApiError,
	assignMemberRole,
	assignRoleMany,
	createTenantUser,
	inviteTenantMember,
	loadTenantUsers,
	loadUsersContext,
	removeMember,
	renameMember,
	resetMemberPassword,
	revokeMemberSessions,
	setMemberScopes,
	setMembershipStatus,
	setMembershipStatusMany,
	startListExport,
} from './api.ts';
import { MEMBER_EXPORT_LIST_ID } from '../domain/lists.ts';
import type { MemberBulkOutcome } from '../services/users-service.ts';
import { memberColumns } from './member-columns.tsrx';
import { MemberDrawer } from './MemberDrawer.tsrx';
import {
	bulkOutcomeCounts,
	bulkTargets,
	createUsersClientState,
	DEFAULT_MEMBER_SORTING,
	loadedListing,
	memberSort,
	membershipStatusMessage,
	ownerCountAfter,
	pageCursor,
	replaceMember,
	resetPageCursors,
	searchPending,
	type Listing,
	type MemberStatusFilter,
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
const SEARCH_DEBOUNCE_MS = 300;

function formValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export function UsersView(props: UsersViewProps) @{
	const usersState = useMemo(() => createUsersClientState(), []);
	/* Answers arrive in any order; only the latest request may write the page. */
	const requests = useMemo(() => ({ sequence: 0 }), []);
	const [users] = useValue(usersState.state.users);
	const [roles] = useValue(usersState.state.roles);
	const [grantableScopes] = useValue(usersState.state.grantableScopes);
	const [actor] = useValue(usersState.state.actor);
	const [passwordMinLength] = useValue(usersState.state.passwordMinLength);
	const [memberCount, setMemberCount] = useValue(usersState.state.memberCount);
	const [ownerCount, setOwnerCount] = useValue(usersState.state.ownerCount);
	const actorIsOwner = actor?.role === 'owner';
	const [status, setStatus] = useValue(usersState.state.status);
	const [error, setError] = useValue(usersState.state.error);
	const [notice, setNotice] = useValue(usersState.state.notice);
	const [query, setQuery] = useValue(usersState.state.query);
	const [appliedQuery] = useValue(usersState.state.appliedQuery);
	const [statusFilter, setStatusFilter] = useValue(
		usersState.state.statusFilter,
	);
	const [sorting, setSorting] = useValue(usersState.state.sorting);
	const [pageIndex] = useValue(usersState.state.pageIndex);
	const [pageSize, setPageSize] = useValue(usersState.state.pageSize);
	const [cursors] = useValue(usersState.state.cursors);
	const [nextCursor] = useValue(usersState.state.nextCursor);
	const [filtersOpen, setFiltersOpen] = useValue(usersState.state.filtersOpen);
	const [selectedIds, setSelectedIds] = useValue(usersState.state.selectedIds);
	const [confirmDeactivateMany, setConfirmDeactivateMany] = useValue(
		usersState.state.confirmDeactivateMany,
	);
	const [roleDialogOpen, setRoleDialogOpen] = useValue(
		usersState.state.roleDialogOpen,
	);
	const [bulkRole, setBulkRole] = useValue(usersState.state.bulkRole);
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
	const selected =
		users.find((user) => user.accountId === selectedAccountId) ?? null;
	const columns = memberColumns(
		new Map(roles.map((role) => [role.key, role.name])),
	);
	const term = query.trim();
	const hasMore = nextCursor !== null;
	const targets = bulkTargets(users, selectedIds, actor?.accountId);
	const assignableRoles = roles.filter(
		(role) => role.key !== 'owner' || actorIsOwner,
	);
	const listing = (): Listing => ({
		pageIndex,
		pageSize,
		sorting,
		query: appliedQuery,
		status: statusFilter,
		cursors,
	});
	/* The search timer fires after later renders; it reads the listing those
   renders left here rather than the one the keystroke saw. */
	const latest = useMemo(() => ({ listing: listing() }), []);
	latest.listing = listing();
	/* A changed order, filter or page size is a new listing, whose cursors
   name positions in the old one. */
	const firstPage = (changes: Partial<Listing>): Listing => ({
		...listing(),
		...changes,
		pageIndex: 0,
		cursors: resetPageCursors(),
	});

	const failLoad = (loadError: unknown) => {
		setError(message(loadError, t('users.error.load')));
		setStatus(
			loadError instanceof ApiError && loadError.status === 403
				? 'denied'
				: 'error',
		);
	};

	/* The server sorts, narrows and cuts the page; the listing travels as an
   argument because the click that changes it and the load it starts happen
   in one render, where the state hooks still read the old values. */
	const load = async (next: Listing) => {
		const cursor = pageCursor(next.cursors, next.pageIndex);
		if (cursor === undefined) return;
		const sequence = requests.sequence + 1;
		requests.sequence = sequence;
		setStatus('loading');
		setError('');
		try {
			const { sort, direction } = memberSort(next.sorting);
			const page = await loadTenantUsers({
				sort,
				direction,
				limit: next.pageSize,
				query: next.query,
				status: next.status,
				cursor,
			});
			if (sequence !== requests.sequence) return;
			const loaded = loadedListing(next, page);
			usersState.store.act((transaction) => {
				transaction.set(usersState.state.users, loaded.users);
				transaction.set(usersState.state.appliedQuery, loaded.appliedQuery);
				transaction.set(usersState.state.pageIndex, loaded.pageIndex);
				transaction.set(usersState.state.cursors, loaded.cursors);
				transaction.set(usersState.state.nextCursor, loaded.nextCursor);
				transaction.set(usersState.state.selectedIds, loaded.selectedIds);
				transaction.set(usersState.state.status, 'idle');
			}, 'users/loaded');
		} catch (loadError) {
			if (sequence === requests.sequence) failLoad(loadError);
		}
	};

	const loadContext = async (): Promise<boolean> => {
		try {
			const context = await loadUsersContext();
			usersState.store.act((transaction) => {
				transaction.set(usersState.state.roles, context.roles);
				transaction.set(
					usersState.state.grantableScopes,
					context.grantableScopes,
				);
				transaction.set(usersState.state.actor, context.actor);
				transaction.set(
					usersState.state.passwordMinLength,
					context.passwordMinLength,
				);
				transaction.set(usersState.state.memberCount, context.memberCount);
				transaction.set(usersState.state.ownerCount, context.ownerCount);
				transaction.set(usersState.state.exportStarted, false);
			}, 'users/context-loaded');
			return true;
		} catch (contextError) {
			failLoad(contextError);
			return false;
		}
	};

	const refresh = async () => {
		setStatus('loading');
		if (await loadContext()) await load(firstPage({}));
	};

	const openPage = (index: number) => {
		if (index !== pageIndex) void load({ ...listing(), pageIndex: index });
	};

	const changeSorting = (sorts: readonly TableSort[]) => {
		const next =
			sorts.length === 0 ? DEFAULT_MEMBER_SORTING : sorts;
		setSorting(next);
		void load(firstPage({ sorting: next }));
	};

	const changeStatusFilter = (value: string) => {
		const next: MemberStatusFilter =
			value === 'active' || value === 'disabled' ? value : '';
		setStatusFilter(next);
		void load(firstPage({ status: next }));
	};

	const changePageSize = (size: number) => {
		setPageSize(size);
		void load(firstPage({ pageSize: size }));
	};

	useEffect(() => {
		void refresh();
	}, []);

	/* The term is the server's filter, so typing it starts a new listing rather
   than narrowing the page on screen: one listing per pause in the typing. */
	useEffect(() => {
		if (!searchPending(query, appliedQuery)) return;
		const timer = setTimeout(
			() => void load({
				...latest.listing,
				query: term,
				pageIndex: 0,
				cursors: resetPageCursors(),
			}),
			SEARCH_DEBOUNCE_MS,
		);
		return () => clearTimeout(timer);
	}, [query]);

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
				usersState.store.act((transaction) => {
					transaction.set(usersState.state.users, replaceMember(users, member));
					transaction.set(
						usersState.state.ownerCount,
						ownerCountAfter(
							ownerCount,
							users.find((user) => user.accountId === member.accountId),
							member,
						),
					);
				}, 'users/member-updated');
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
	const changeMembership = async (
		member: TenantMember,
		next: 'active' | 'disabled',
	) => {
		await mutate(
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
		/* Under a status filter the row no longer belongs on this page. */
		if (statusFilter !== '') await load(listing());
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
			element.reset();
			setFormSession((current) => current + 1);
			setFormOpen(false);
			setMemberCount(memberCount + 1);
			if (user.role === 'owner') setOwnerCount(ownerCount + 1);
			/* The new row belongs wherever the order puts it; the first page of
   the listing shows it or the page it is on does. */
			await load(firstPage({}));
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

	/* Both bulk actions go the same way: the selected ids on screen, one
   outcome per id, then the listing is read again and the counts are told.
   A refused or missing id is a count, never a failure of the call. */
	const applyMany = async (
		run: (ids: readonly string[]) => Promise<readonly MemberBulkOutcome[]>,
		done: string,
		fallback: string,
	) => {
		const ids = targets;
		if (ids.length === 0) return;
		setStatus('submitting');
		setError('');
		setNotice('');
		try {
			const outcomes = await run(ids);
			await load(listing());
			toasts.success(t(done, bulkOutcomeCounts(outcomes)));
		} catch (bulkError) {
			setError(message(bulkError, t(fallback)));
			setStatus('idle');
		}
	};

	const deactivateMany = () => {
		setConfirmDeactivateMany(false);
		void applyMany(
			(ids) => setMembershipStatusMany(ids, 'disabled', props.csrfToken),
			'users.notice.deactivatedMany',
			'users.error.deactivateMany',
		);
	};

	const assignRoleToMany = () => {
		const role = bulkRole || (assignableRoles[0]?.key ?? '');
		setRoleDialogOpen(false);
		if (role === '') return;
		/* A role handed to several rows moves the owner count by an amount only
   the server knows, so the context is read again with the page. */
		void applyMany(async (ids) => {
			const outcomes = await assignRoleMany(ids, role, props.csrfToken);
			await loadContext();
			return outcomes;
		}, 'users.notice.roleAssignedMany', 'users.error.roleMany');
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
			setSelectedAccountId(null);
			setMemberCount(memberCount - 1);
			if (selected.role === 'owner') setOwnerCount(ownerCount - 1);
			await load(listing());
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
						accounts: memberCount,
						owners: ownerCount,
					})}
					search={<SearchField
						value={query}
						placeholder={t('users.search.placeholder')}
						label={t('users.search.label')}
						onInput={setQuery}
					/>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={statusFilter === '' ? 0 : 1}
						label={t('users.filter.label')}
					>
						<Select
							id="users-status-filter"
							label={t('users.filter.status')}
							value={statusFilter}
							options={[
								{ value: '', label: t('users.filter.allStatuses') },
								{ value: 'active', label: t('users.status.active') },
								{ value: 'disabled', label: t('users.status.disabled') },
							]}
							onChange={changeStatusFilter}
						/>
					</Filters>}
					caption={t('users.table.caption')}
					mode="server"
					columns={columns}
					rows={users}
					rowKey={(user) => user.accountId}
					sorting
					sortingState={sorting}
					onSortingChange={changeSorting}
					pagination={{
						pageIndex,
						pageSize,
						onPageChange: openPage,
						hasMore,
					}}
					after={<Pagination
						pageIndex={pageIndex}
						pageSize={pageSize}
						hasMore={hasMore}
						pageSizes={PAGE_SIZES}
						onPageChange={openPage}
						onPageSizeChange={changePageSize}
						label={t('users.pagination.label')}
						previousLabel={t('users.pagination.previous')}
						nextLabel={t('users.pagination.next')}
						pageSizeLabel={t('users.pagination.size')}
						summary={(page) => t('users.pagination.summary', {
							page: page.pageIndex + 1,
							from: page.from,
						})}
					/>}
					status={status === 'loading' ? 'loading' : 'idle'}
					loadingLabel={t('users.table.loading')}
					filtered={appliedQuery !== '' || statusFilter !== ''}
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
					selection={props.canManage
						? {
								selectedKeys: selectedIds,
								onSelectionChange: setSelectedIds,
								label: t('users.selection.label'),
								rowLabel: (user) => t('users.selection.rowLabel', {
									name: user.displayName,
								}),
								selectable: (user) => user.accountId !== actor?.accountId,
								clearLabel: t('users.selection.clear'),
							}
						: undefined}
					bulkActions={props.canManage
						? [
								{
									id: 'deactivate-selected',
									label: t('users.action.deactivateSelected'),
									icon: 'x',
									tone: 'danger',
									disabled: targets.length === 0 || status === 'submitting',
									reason: targets.length === 0
										? t('users.action.bulkRefused')
										: undefined,
									onSelect: () => setConfirmDeactivateMany(true),
								},
								{
									id: 'assign-role-selected',
									label: t('users.action.assignRoleSelected'),
									icon: 'shield',
									disabled: targets.length === 0 || status === 'submitting',
									reason: targets.length === 0
										? t('users.action.bulkRefused')
										: undefined,
									onSelect: () => {
										setBulkRole(assignableRoles[0]?.key ?? '');
										setRoleDialogOpen(true);
									},
								},
							]
						: undefined}
					selectionSummary={(count) => t('users.selection.summary', {
						count,
					})}
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
			open={confirmDeactivateMany}
			title={t('users.deactivateMany.title')}
			confirmLabel={t('users.action.deactivateSelected')}
			busy={status === 'submitting'}
			onConfirm={deactivateMany}
			onCancel={() => setConfirmDeactivateMany(false)}
		>{t('users.deactivateMany.description', {
			count: targets.length,
		})}</ConfirmDialog>
		<ConfirmDialog
			open={roleDialogOpen}
			title={t('users.roleMany.title')}
			confirmLabel={t('users.action.assignRoleSelected')}
			tone="primary"
			busy={status === 'submitting'}
			onConfirm={assignRoleToMany}
			onCancel={() => setRoleDialogOpen(false)}
		>
			<p>{t('users.roleMany.description', { count: targets.length })}</p>
			<Select
				id="users-bulk-role"
				label={t('users.form.role')}
				value={bulkRole}
				options={assignableRoles.map(
					(role) => ({
						value: role.key,
						label: role.name,
					}),
				)}
				onChange={setBulkRole}
			/>
		</ConfirmDialog>
		<ToastHost
			label={t('users.common.messages')}
			closeLabel={t('users.action.close')}
		/>
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
	const [memberCount, setMemberCount] = useValue(widgetState.state.memberCount);
	const [status, setStatus] = useValue(widgetState.state.status);
	useEffect(() => {
		setStatus('loading');
		void loadUsersContext().then(
			(context) => setMemberCount(context.memberCount),
		).catch(() => undefined).finally(() => setStatus('idle'));
	}, []);
	<Kpi
		label={t('users.widget.label')}
		value={status === 'loading'
			? '…'
			: new Intl.NumberFormat(activeLocale()).format(memberCount)}
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
