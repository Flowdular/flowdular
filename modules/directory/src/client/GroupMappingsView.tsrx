import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	Drawer,
	EmptyState,
	FormField,
	Icon,
	PageHeader,
	Pagination,
	SearchField,
	Select,
	TableCard,
	Tag,
	ToastHost,
	toasts,
	type TableAction,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import {
	GROUP_SORT_KEYS,
	type GroupSortKey,
	type ScimGroupMapping,
} from '../domain/types.ts';
import {
	directoryErrorMessage,
	DirectoryApiError,
	loadGroupMappingContext,
	loadGroupMappings,
	mapGroup,
} from './api.ts';
import { tableEmpty } from './presentation.ts';
import {
	createGroupMappingsClientState,
	FIRST_PAGE,
	hasNextPage,
	PAGE_SIZE,
	pageCursor,
	pageLoaded,
	sortingState,
	sortOf,
	turnTo,
	type ListPaging,
	type ListSort,
} from './state.ts';

export interface GroupMappingsViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

const ROLE_FIELD_ID = 'directory-group-role';

/** One listing per pause in the typing, not one per keystroke. */
const SEARCH_DEBOUNCE_MS = 300;

function columns(
	defaultRole: string,
): readonly TableColumn<ScimGroupMapping>[] {
	return [
		{
			key: 'displayName',
			header: t('directory.groups.column.name'),
			width: '34%',
			value: (group) => group.displayName,
			cell: (group) => <span class="ui-cell">
				<b>{group.displayName}</b>
				{group.externalId
					? <small class="ui-cell__muted ui-mono">{group.externalId}</small>
					: null}
			</span>,
		},
		{
			key: 'roleKey',
			header: t('directory.groups.column.role'),
			width: '24%',
			cell: (group) => group.roleKey === null
				? <Tag tone="neutral">{t('directory.groups.unmapped', {
						role: defaultRole,
					})}</Tag>
				: <Tag tone="info" mono>{group.roleKey}</Tag>,
		},
		{
			key: 'precedence',
			header: t('directory.groups.column.precedence'),
			width: '18%',
			numeric: true,
			value: (group) => group.precedence,
			cell: (group) => String(group.precedence),
		},
		{
			key: 'memberCount',
			header: t('directory.groups.column.members'),
			width: '18%',
			numeric: true,
			cell: (group) => String(group.memberCount),
		},
	];
}

export function GroupMappingsView(props: GroupMappingsViewProps) @{
	const client = useMemo(() => createGroupMappingsClientState(), []);
	const [groups] = useValue(client.state.groups);
	const [roles] = useValue(client.state.roles);
	const [defaultRole] = useValue(client.state.defaultRole);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [appliedQuery] = useValue(client.state.appliedQuery);
	const [sort] = useValue(client.state.sort);
	const [paging] = useValue(client.state.paging);
	const [editorOpen] = useValue(client.state.editorOpen);
	const [selectedId] = useValue(client.state.selectedId);
	const [roleKey, setRoleKey] = useValue(client.state.roleKey);
	const [precedence, setPrecedence] = useValue(client.state.precedence);
	const selected = groups.find((group) => group.id === selectedId) ?? null;
	const term = query.trim();

	const failed = (loadError: unknown) => {
		setError(directoryErrorMessage(loadError, 'directory.groups.error.load'));
		setStatus(
			loadError instanceof DirectoryApiError && loadError.status === 403
				? 'denied'
				: 'error',
		);
	};

	/* The server sorts, narrows and cuts the page, so every argument travels
   explicitly: a control change and the load it starts happen in one render,
   where the state hook still reads the value before the change. */
	const load = async (
		search: string,
		order: ListSort<GroupSortKey>,
		target: ListPaging,
	) => {
		const ticket = client.loads.begin();
		setStatus('loading');
		setError('');
		try {
			const page = await loadGroupMappings({
				q: search,
				sort: order.sort,
				direction: order.direction,
				cursor: pageCursor(target),
				limit: PAGE_SIZE,
			});
			if (!client.loads.isLatest(ticket)) return;
			client.store.act((transaction) => {
				transaction.set(client.state.groups, page.items);
				transaction.set(client.state.appliedQuery, search);
				transaction.set(
					client.state.paging,
					pageLoaded(target, page.page.nextCursor),
				);
				transaction.set(client.state.status, 'idle');
			}, 'directory/groups-loaded');
		} catch (loadError) {
			if (client.loads.isLatest(ticket)) failed(loadError);
		}
	};

	const refresh = () => load(appliedQuery, sort, paging);

	/* A changed filter or sort is a new listing: it starts from the first page. */
	const restart = (search: string, order: ListSort<GroupSortKey>) => {
		client.store.act((transaction) => {
			transaction.set(client.state.sort, order);
			transaction.set(client.state.paging, FIRST_PAGE);
		}, 'directory/groups-restart');
		void load(search, order, FIRST_PAGE);
	};

	const turn = (pageIndex: number) => {
		const target = turnTo(paging, pageIndex);
		if (target === paging) return;
		void load(appliedQuery, sort, target);
	};

	/* The roles and the default role serve the form for every page, so they
   are read once with the first page rather than fanned out per page. */
	useEffect(() => {
		void refresh();
		void loadGroupMappingContext().then((context) => {
			client.store.act((transaction) => {
				transaction.set(client.state.roles, context.roles);
				transaction.set(client.state.defaultRole, context.defaultRole);
			}, 'directory/groups-context');
		}).catch(failed);
	}, []);

	/* The listing is read when the timer fires, not when it was set: a sort
   changed during the pause belongs to the load this starts. */
	useEffect(() => {
		if (term === appliedQuery) return;
		const timer = setTimeout(() => {
			const query = client.store.get(client.state.query).trim();
			if (query === client.store.get(client.state.appliedQuery)) return;
			restart(query, client.store.get(client.state.sort));
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [term]);

	/* The drawer opens on the role, which is what the reader came to change.
   `Select` owns no autoFocus of its own yet, so the control is reached by
   the id it already carries; a promotion candidate for @flowdular/ui. */
	useEffect(() => {
		if (editorOpen) document.getElementById(ROLE_FIELD_ID)?.focus();
	}, [editorOpen]);

	const open = (group: ScimGroupMapping) => {
		client.store.act((transaction) => {
			transaction.set(client.state.selectedId, group.id);
			transaction.set(client.state.roleKey, group.roleKey ?? '');
			transaction.set(client.state.precedence, String(group.precedence));
			transaction.set(client.state.error, '');
			transaction.set(client.state.editorOpen, true);
		}, 'directory/group-open');
	};

	const close = () => {
		client.store.act((transaction) => {
			transaction.set(client.state.editorOpen, false);
			transaction.set(client.state.error, '');
		}, 'directory/group-close');
	};

	const save = async (event: SubmitEvent) => {
		event.preventDefault();
		if (!selected) return;
		const parsed = Number(precedence);
		if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000) {
			setError(t('directory.groups.error.precedence'));
			return;
		}
		setStatus('submitting');
		setError('');
		try {
			await mapGroup(
				{
					id: selected.id,
					roleKey: roleKey === '' ? null : roleKey,
					precedence: parsed,
				},
				props.csrfToken,
			);
			await refresh();
			close();
			toasts.success(t('directory.groups.notice.saved'));
		} catch (saveError) {
			setError(directoryErrorMessage(saveError, 'directory.groups.error.save'));
			setStatus('idle');
		}
	};

	const rowActions = (group: ScimGroupMapping): readonly TableAction[] =>
		props.canManage
			? [
					{
						id: 'map',
						label: t('directory.groups.action.map'),
						icon: 'settings',
						onSelect: () => open(group),
					},
				]
			: [];

	<div class="ui-view">
		<PageHeader
			eyebrow={t('directory.common.administration')}
			title={t('directory.groups.title')}
			description={t('directory.groups.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh()}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('directory.common.refreshing')
					: t('directory.common.refresh')}
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('directory.common.accessDenied')}>{t(
					'directory.groups.denied',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (error && !editorOpen) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('directory.groups.table.title')}
					search={<SearchField
						value={query}
						placeholder={t('directory.groups.search.placeholder')}
						label={t('directory.groups.search.label')}
						onInput={setQuery}
					/>}
					caption={t('directory.groups.table.caption')}
					columns={columns(defaultRole)}
					rows={groups}
					rowKey={(group) => group.id}
					mode="server"
					sorting
					sortingState={sortingState(sort)}
					onSortingChange={(sorts) => restart(
						appliedQuery,
						sortOf(sorts, GROUP_SORT_KEYS, 'precedence'),
					)}
					pagination={{
						pageIndex: paging.pageIndex,
						pageSize: PAGE_SIZE,
						hasMore: hasNextPage(paging),
						onPageChange: turn,
					}}
					status={status === 'loading' && groups.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('directory.groups.table.loading')}
					filtered={appliedQuery !== ''}
					empty={tableEmpty(status, {
						icon: 'users',
						title: t('directory.groups.empty.title'),
						hint: t('directory.groups.empty.hint'),
					})}
					emptyFiltered={tableEmpty(status, {
						icon: 'search',
						title: t('directory.groups.emptyFiltered.title'),
						hint: t('directory.groups.emptyFiltered.hint'),
					})}
					onSelect={props.canManage ? open : undefined}
					selectedKey={selected?.id}
					actions={rowActions}
					actionsLabel={t('directory.common.actions')}
					actionsWidth="180px"
					after={<Pagination
						pageIndex={paging.pageIndex}
						pageSize={PAGE_SIZE}
						hasMore={hasNextPage(paging)}
						onPageChange={turn}
						label={t('directory.groups.pagination.label')}
						previousLabel={t('directory.common.pagination.previous')}
						nextLabel={t('directory.common.pagination.next')}
						summary={(page) => t('directory.common.pagination.summary', {
							page: page.pageIndex + 1,
							from: page.from,
						})}
					/>}
					noteIcon="info"
					note={t('directory.groups.note', { role: defaultRole })}
				/>
			</>
		}
		<Drawer
			open={editorOpen}
			title={selected?.displayName ?? ''}
			subtitle={t('directory.groups.drawer.subtitle')}
			onClose={close}
		>
			<form class="ui-drawer__form" onSubmit={(event) => void save(event)}>
				<div class="ui-drawer__body">
					<div class="ui-form">
						<Select
							id={ROLE_FIELD_ID}
							label={t('directory.groups.form.role')}
							value={roleKey}
							options={[
								{
									value: '',
									label: t('directory.groups.form.noRole', {
										role: defaultRole,
									}),
								},
								...roles.map((role) => ({ value: role, label: role })),
							]}
							help={t('directory.groups.form.roleHelp')}
							disabled={!props.canManage}
							autoFocus
							onChange={setRoleKey}
						/>
						<FormField
							label={t('directory.groups.form.precedence')}
							help={t('directory.groups.form.precedenceHelp')}
						>
							<input
								class="ui-input"
								type="number"
								min={0}
								max={10000}
								value={precedence}
								disabled={!props.canManage}
								onInput={(event: Event) => setPrecedence(
									(event.currentTarget as HTMLInputElement).value,
								)}
							/>
						</FormField>
						@if (error) {
							<Alert>{error}</Alert>
						}
					</div>
				</div>
				<div class="ui-drawer__foot">
					<small>{t('directory.groups.form.note')}</small>
					<div class="ui-form__actions">
						<Button onClick={close}>{t('directory.common.cancel')}</Button>
						<Button
							variant="primary"
							type="submit"
							disabled={!props.canManage || status === 'submitting'}
						>
							{status === 'submitting'
								? t('directory.common.saving')
								: t('directory.groups.form.save')}
						</Button>
					</div>
				</div>
			</form>
		</Drawer>
		<ToastHost
			label={t('directory.common.messages')}
			closeLabel={t('directory.common.close')}
		/>
	</div>
}
