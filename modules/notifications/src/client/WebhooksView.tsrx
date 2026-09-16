import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	CellCode,
	CellMuted,
	CellStack,
	CellTag,
	CellText,
	CellTime,
	ConfirmDialog,
	Drawer,
	EmptyState,
	Filters,
	Icon,
	PageHeader,
	Pagination,
	SearchField,
	Select,
	TableCard,
	ToastHost,
	toasts,
	type TableAction,
	type TableColumn,
	type TableSort,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import {
	SUBSCRIPTION_STATUSES,
	type WebhookSubscription,
	type WebhookSubscriptionStatus,
} from '../domain/types.ts';
import {
	createWebhook,
	deleteWebhook,
	disableWebhook,
	loadWebhooks,
	NotificationsApiError,
	notificationsErrorMessage,
	pauseWebhook,
	resumeWebhook,
	rotateWebhookSecret,
	updateWebhook,
} from './api.ts';
import {
	subscriptionStatusLabel,
	subscriptionStatusTone,
} from './presentation.ts';
import {
	createWebhooksClientState,
	FIRST_PAGE,
	pageCursor,
	pageLoaded,
	searchPending,
	type CursorStack,
	type SortDirection,
} from './state.ts';
import { WebhookForm, type WebhookFormValue } from './WebhookForm.tsrx';

export interface WebhooksViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

const PAGE_SIZES = [10, 25, 50, 100];
const SEARCH_DEBOUNCE_MS = 300;

/** One page request: the filters, the order, the page and the cursors that reach it. */
interface WebhooksRequest {
	readonly status: WebhookSubscriptionStatus | '';
	readonly search: string;
	readonly direction: SortDirection;
	readonly pageIndex: number;
	readonly pageSize: number;
	readonly pages: CursorStack;
}

function columns(): readonly TableColumn<WebhookSubscription>[] {
	return [
		{
			key: 'name',
			header: t('notifications.webhooks.column.name'),
			width: 'auto',
			value: (subscription) => subscription.name,
			cell: (subscription) => <CellStack
				primary={subscription.name}
				secondary={t('notifications.webhooks.table.events', {
					count: subscription.events.length,
				})}
			/>,
		},
		{
			key: 'url',
			header: t('notifications.webhooks.column.url'),
			width: '240px',
			priority: 2,
			cell: (subscription) => <CellText value={subscription.url} mono />,
		},
		{
			key: 'status',
			header: t('notifications.webhooks.column.status'),
			width: '120px',
			cell: (subscription) =>
				<CellTag
					tone={subscriptionStatusTone(subscription.status)}
					dot
					label={subscriptionStatusLabel(subscription.status)}
				/>,
		},
		{
			key: 'lastDeliveryAt',
			header: t('notifications.webhooks.column.lastDelivery'),
			width: '170px',
			priority: 2,
			cell: (subscription) => subscription.lastDeliveryAt === null
				? <CellMuted>{t('notifications.common.notYet')}</CellMuted>
				: <CellTime value={subscription.lastDeliveryAt} />,
		},
		{
			key: 'secretFingerprint',
			header: t('notifications.webhooks.column.fingerprint'),
			width: '170px',
			priority: 3,
			cell: (subscription) =>
				<CellCode value={subscription.secretFingerprint} />,
		},
	];
}

export function WebhooksView(props: WebhooksViewProps) @{
	const client = useMemo(() => createWebhooksClientState(), []);
	/* Requests answer out of order; only the latest one may write the screen. */
	const requests = useMemo(() => ({ sequence: 0 }), []);
	const [subscriptions] = useValue(client.state.subscriptions);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [appliedQuery] = useValue(client.state.appliedQuery);
	const [statusFilter] = useValue(client.state.statusFilter);
	const [direction] = useValue(client.state.direction);
	const [pageIndex] = useValue(client.state.pageIndex);
	const [pageSize] = useValue(client.state.pageSize);
	const [pages] = useValue(client.state.pages);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [editorOpen, setEditorOpen] = useValue(client.state.editorOpen);
	const [selectedId, setSelectedId] = useValue(client.state.selectedId);
	const [formSession, setFormSession] = useValue(client.state.formSession);
	const [secret, setSecret] = useValue(client.state.revealedSecret);
	const [confirm, setConfirm] = useValue(client.state.confirm);
	const selected =
		subscriptions.find(
			(subscription) => subscription.id === selectedId,
		) ?? null;
	const filtered = appliedQuery !== '' || statusFilter !== '';
	const sorting: readonly TableSort[] = [
		{ key: 'name', desc: direction === 'desc' },
	];
	const current: WebhooksRequest = {
		status: statusFilter,
		search: appliedQuery,
		direction,
		pageIndex,
		pageSize,
		pages,
	};

	/* The server sorts, narrows and cuts the page: every request names its
   filters, its order, its page and the cursor that opens it, and the
   response records the cursor of the page after it. */
	const load = async (request: WebhooksRequest) => {
		const cursor = pageCursor(request.pages, request.pageIndex);
		if (cursor === null) return;
		const sequence = requests.sequence += 1;
		client.store.act((transaction) => {
			transaction.set(client.state.statusFilter, request.status);
			transaction.set(client.state.appliedQuery, request.search);
			transaction.set(client.state.direction, request.direction);
			transaction.set(client.state.pageIndex, request.pageIndex);
			transaction.set(client.state.pageSize, request.pageSize);
			transaction.set(client.state.pages, request.pages);
			transaction.set(client.state.status, 'loading');
			transaction.set(client.state.error, '');
		}, 'notifications/webhooks-request');
		try {
			const page = await loadWebhooks({
				status: request.status,
				search: request.search,
				direction: request.direction,
				limit: request.pageSize,
				cursor,
			});
			if (sequence !== requests.sequence) return;
			client.store.act((transaction) => {
				transaction.set(client.state.subscriptions, page.items);
				transaction.set(
					client.state.pages,
					pageLoaded(request.pages, request.pageIndex, page.page.nextCursor),
				);
				transaction.set(client.state.status, 'idle');
			}, 'notifications/webhooks-loaded');
		} catch (loadError) {
			if (sequence !== requests.sequence) return;
			setError(
				notificationsErrorMessage(
					loadError,
					'notifications.webhooks.error.load',
				),
			);
			setStatus(
				loadError instanceof NotificationsApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	/* The page on screen, read again: what a lifecycle action leaves behind. */
	const refresh = () => load(current);

	/* A filter, a term or an order starts a new listing from its first page. */
	const restart = (change: Partial<WebhooksRequest>) => load({
		...current,
		...change,
		pageIndex: 0,
		pages: FIRST_PAGE,
	});

	useEffect(() => {
		void load(current);
	}, []);

	/* The term is the server's filter, so typing it starts a new listing rather
   than narrowing the page on screen. One listing per pause in the typing, and
   none at all while the rows already answer this term. */
	useEffect(() => {
		if (!searchPending(query, appliedQuery)) return;
		const timer = setTimeout(
			() => void restart({ search: query.trim() }),
			SEARCH_DEBOUNCE_MS,
		);
		return () => clearTimeout(timer);
	}, [query]);

	const openNew = () => {
		client.store.act((transaction) => {
			transaction.set(client.state.selectedId, '');
			transaction.set(client.state.revealedSecret, '');
			transaction.set(client.state.formSession, formSession + 1);
			transaction.set(client.state.error, '');
			transaction.set(client.state.editorOpen, true);
		}, 'notifications/webhook-new');
	};

	const openSubscription = (id: string) => {
		client.store.act((transaction) => {
			transaction.set(client.state.selectedId, id);
			transaction.set(client.state.revealedSecret, '');
			transaction.set(client.state.formSession, formSession + 1);
			transaction.set(client.state.error, '');
			transaction.set(client.state.editorOpen, true);
		}, 'notifications/webhook-open');
	};

	const closeEditor = () => {
		client.store.act((transaction) => {
			transaction.set(client.state.editorOpen, false);
			transaction.set(client.state.revealedSecret, '');
			transaction.set(client.state.confirm, null);
			transaction.set(client.state.error, '');
		}, 'notifications/webhook-close');
	};

	const submit = async (value: WebhookFormValue) => {
		setStatus('submitting');
		setError('');
		try {
			if (selected) {
				await updateWebhook(selected.id, value, props.csrfToken);
				await refresh();
				setEditorOpen(false);
				toasts.success(t('notifications.webhooks.notice.saved'));
			} else {
				const created = await createWebhook(value, props.csrfToken);
				await refresh();
				/* The drawer stays open on the new record: the secret in the
   response is the only time anyone can read it. */
				client.store.act((transaction) => {
					transaction.set(client.state.selectedId, created.subscription.id);
					transaction.set(client.state.revealedSecret, created.secret);
					transaction.set(client.state.formSession, formSession + 1);
				}, 'notifications/webhook-created');
			}
			setStatus('idle');
		} catch (submitError) {
			setError(
				notificationsErrorMessage(
					submitError,
					'notifications.webhooks.error.save',
				),
			);
			setStatus('idle');
		}
	};

	/* A failure is reported where the reader started the action: beside the
   controls in the drawer, or under the header when the row raised it. */
	const act = async (
		run: () => Promise<unknown>,
		done: string,
		reportTo: 'drawer' | 'screen',
	) => {
		setStatus('submitting');
		setError('');
		try {
			await run();
			await refresh();
			setStatus('idle');
			toasts.success(done);
		} catch (actionError) {
			const message = notificationsErrorMessage(
				actionError,
				'notifications.webhooks.error.action',
			);
			if (reportTo === 'drawer') setError(message);
			else {
				/* The drawer is the only place the secret is ever shown, so the
   change that closes it drops the secret with it. */
				client.store.act((transaction) => {
					transaction.set(client.state.error, message);
					transaction.set(client.state.editorOpen, false);
					transaction.set(client.state.revealedSecret, '');
				}, 'notifications/webhook-action-failed');
			}
			setStatus('idle');
		}
	};

	const rotate = async () => {
		if (!selected) return;
		setConfirm(null);
		setStatus('submitting');
		setError('');
		try {
			const rotated = await rotateWebhookSecret(selected.id, props.csrfToken);
			await refresh();
			client.store.act((transaction) => {
				transaction.set(client.state.revealedSecret, rotated.secret);
				transaction.set(client.state.formSession, formSession + 1);
				transaction.set(client.state.status, 'idle');
			}, 'notifications/webhook-rotated');
			toasts.success(t('notifications.webhooks.notice.rotated'));
		} catch (rotateError) {
			setError(
				notificationsErrorMessage(
					rotateError,
					'notifications.webhooks.error.action',
				),
			);
			setStatus('idle');
		}
	};

	const remove = async () => {
		if (!selected) return;
		const id = selected.id;
		setConfirm(null);
		closeEditor();
		await act(
			() => deleteWebhook(id, props.csrfToken),
			t('notifications.webhooks.notice.deleted'),
			'screen',
		);
		setSelectedId('');
	};

	const disable = async () => {
		if (!selected) return;
		setConfirm(null);
		await act(
			() => disableWebhook(selected.id, props.csrfToken),
			t('notifications.webhooks.notice.disabled'),
			'drawer',
		);
	};

	const rowActions = (
		subscription: WebhookSubscription,
	): readonly TableAction[] => [
		{
			id: 'open',
			label: t('notifications.webhooks.action.open'),
			icon: 'file-text',
			onSelect: () => openSubscription(subscription.id),
		},
		...(props.canManage
			? [
					subscription.status === 'active'
						? {
								id: 'pause',
								label: t('notifications.webhooks.action.pause'),
								icon: 'panel-left',
								onSelect: () => void act(
									() => pauseWebhook(subscription.id, props.csrfToken),
									t('notifications.webhooks.notice.paused'),
									'screen',
								),
							}
						: {
								id: 'resume',
								label: t('notifications.webhooks.action.resume'),
								icon: 'play',
								onSelect: () => void act(
									() => resumeWebhook(subscription.id, props.csrfToken),
									t('notifications.webhooks.notice.resumed'),
									'screen',
								),
							},
				]
			: []),
	];

	<div class="ui-view">
		<PageHeader
			eyebrow={t('notifications.common.administration')}
			title={t('notifications.webhooks.title')}
			description={t('notifications.webhooks.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh()}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('notifications.common.refreshing')
					: t('notifications.common.refresh')}
			</Button>
			@if (props.canManage) {
				<Button
					size="sm"
					variant="primary"
					disabled={status === 'denied'}
					onClick={openNew}
				>
					<Icon name="plus" size={14} />
					{t('notifications.webhooks.action.new')}
				</Button>
			}
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState
					icon="shield"
					title={t('notifications.common.accessDenied')}
				>{t('notifications.webhooks.denied')}</EmptyState>
			</section>
		} @else {
			<>
				@if (error && !editorOpen) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('notifications.webhooks.table.title')}
					count={pages.hasMore
						? t('notifications.webhooks.table.countMore', {
								count: subscriptions.length,
							})
						: t('notifications.webhooks.table.count', {
								count: subscriptions.length,
							})}
					search={<SearchField
						value={query}
						placeholder={t('notifications.webhooks.search.placeholder')}
						label={t('notifications.webhooks.search.label')}
						onInput={setQuery}
					/>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={statusFilter === '' ? 0 : 1}
						label={t('notifications.common.filters')}
					>
						<Select
							id="notifications-webhooks-status"
							label={t('notifications.webhooks.filter.status')}
							value={statusFilter}
							options={[
								{
									value: '',
									label: t('notifications.webhooks.filter.allStatuses'),
								},
								...SUBSCRIPTION_STATUSES.map(
									(entry) => ({
										value: entry,
										label: subscriptionStatusLabel(entry),
									}),
								),
							]}
							onChange={(value) => void restart({
								status: value as WebhookSubscriptionStatus | '',
							})}
						/>
					</Filters>}
					caption={t('notifications.webhooks.table.caption')}
					columns={columns()}
					rows={subscriptions}
					rowKey={(subscription) => subscription.id}
					mode="server"
					sorting
					sortingState={sorting}
					onSortingChange={(sorts) => void restart({
						direction: sorts[0]?.desc === true ? 'desc' : 'asc',
					})}
					pagination={{
						pageIndex,
						pageSize,
						hasMore: pages.hasMore,
						onPageChange: (index) => void load({
							...current,
							pageIndex: index,
						}),
					}}
					after={<Pagination
						pageIndex={pageIndex}
						pageSize={pageSize}
						hasMore={pages.hasMore}
						pageSizes={PAGE_SIZES}
						onPageChange={(index) => void load({
							...current,
							pageIndex: index,
						})}
						onPageSizeChange={(size) => void restart({ pageSize: size })}
						label={t('notifications.pagination.label')}
						previousLabel={t('notifications.pagination.previous')}
						nextLabel={t('notifications.pagination.next')}
						pageSizeLabel={t('notifications.pagination.size')}
						summary={(page) => t('notifications.pagination.keysetSummary', {
							page: page.pageIndex + 1,
							from: page.from,
						})}
					/>}
					status={status === 'loading' && subscriptions.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('notifications.webhooks.table.loading')}
					filtered={filtered}
					empty={{
						icon: 'plug',
						title: t('notifications.webhooks.empty.title'),
						hint: t('notifications.webhooks.empty.hint'),
					}}
					emptyFiltered={{
						icon: 'search',
						title: t('notifications.webhooks.emptyFiltered.title'),
						hint: t('notifications.webhooks.emptyFiltered.hint'),
					}}
					onSelect={(subscription) => openSubscription(subscription.id)}
					selectedKey={selected?.id}
					actions={rowActions}
					actionsLabel={t('notifications.common.actions')}
					actionsWidth="280px"
					noteIcon="shield"
					note={t('notifications.webhooks.note')}
				/>
			</>
		}
		<Drawer
			open={editorOpen}
			title={selected?.name ?? t('notifications.webhooks.drawer.newTitle')}
			subtitle={selected
				? t('notifications.webhooks.drawer.subtitle')
				: t('notifications.webhooks.drawer.newSubtitle')}
			width="lg"
			onClose={closeEditor}
		>
			<WebhookForm
				key={'webhook-form-' + formSession}
				subscription={selected}
				canManage={props.canManage}
				busy={status === 'submitting'}
				secret={secret}
				error={editorOpen ? error : ''}
				onCancel={closeEditor}
				onPause={() => {
					if (selected) {
						void act(
							() => pauseWebhook(selected.id, props.csrfToken),
							t('notifications.webhooks.notice.paused'),
							'drawer',
						);
					}
				}}
				onResume={() => {
					if (selected) {
						void act(
							() => resumeWebhook(selected.id, props.csrfToken),
							t('notifications.webhooks.notice.resumed'),
							'drawer',
						);
					}
				}}
				onDisable={() => setConfirm('disable')}
				onRotate={() => setConfirm('rotate')}
				onDelete={() => setConfirm('delete')}
				onSubmit={(value) => void submit(value)}
			/>
		</Drawer>
		<ConfirmDialog
			open={confirm === 'rotate'}
			title={t('notifications.webhooks.rotate.title')}
			confirmLabel={t('notifications.webhooks.action.rotate')}
			tone="primary"
			busy={status === 'submitting'}
			onConfirm={() => void rotate()}
			onCancel={() => setConfirm(null)}
		>{t('notifications.webhooks.rotate.description', {
			name: selected?.name ?? '',
		})}</ConfirmDialog>
		<ConfirmDialog
			open={confirm === 'disable'}
			title={t('notifications.webhooks.disable.title')}
			confirmLabel={t('notifications.webhooks.action.disable')}
			tone="primary"
			busy={status === 'submitting'}
			onConfirm={() => void disable()}
			onCancel={() => setConfirm(null)}
		>{t('notifications.webhooks.disable.description', {
			name: selected?.name ?? '',
		})}</ConfirmDialog>
		<ConfirmDialog
			open={confirm === 'delete'}
			title={t('notifications.webhooks.delete.title')}
			confirmLabel={t('notifications.webhooks.action.delete')}
			busy={status === 'submitting'}
			onConfirm={() => void remove()}
			onCancel={() => setConfirm(null)}
		>{t('notifications.webhooks.delete.description', {
			name: selected?.name ?? '',
		})}</ConfirmDialog>
		<ToastHost
			label={t('notifications.common.messages')}
			closeLabel={t('notifications.common.close')}
		/>
	</div>
}
