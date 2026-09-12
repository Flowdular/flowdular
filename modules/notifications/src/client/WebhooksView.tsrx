import { useEffect, useMemo, useState } from 'octane';
import {
	Alert,
	Button,
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
	Tag,
	ToastHost,
	toasts,
	type TableAction,
	type TableColumn,
} from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
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
	timestampLabel,
} from './presentation.ts';
import { createWebhooksClientState } from './state.ts';
import { WebhookForm, type WebhookFormValue } from './WebhookForm.tsrx';

export interface WebhooksViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

const PAGE_SIZES = [10, 25, 50, 100];

function columns(): readonly TableColumn<WebhookSubscription>[] {
	return [
		{
			key: 'name',
			header: t('notifications.webhooks.column.name'),
			width: '24%',
			value: (subscription) => subscription.name,
			cell: (subscription) => <span class="ui-cell">
				<b>{subscription.name}</b>
				<small class="ui-cell__muted">{t(
					'notifications.webhooks.table.events',
					{ count: subscription.events.length },
				)}</small>
			</span>,
		},
		{
			key: 'url',
			header: t('notifications.webhooks.column.url'),
			width: '24%',
			value: (subscription) => subscription.url,
			cell: (subscription) => <span class="ui-mono">{subscription.url}</span>,
		},
		{
			key: 'status',
			header: t('notifications.webhooks.column.status'),
			width: '10%',
			value: (subscription) => subscription.status,
			cell: (subscription) =>
				<Tag
					tone={subscriptionStatusTone(subscription.status)}
					dot
				>{subscriptionStatusLabel(subscription.status)}</Tag>,
		},
		{
			key: 'lastDeliveryAt',
			header: t('notifications.webhooks.column.lastDelivery'),
			width: '14%',
			value: (subscription) => subscription.lastDeliveryAt ?? 0,
			cell: (subscription) => timestampLabel(subscription.lastDeliveryAt),
		},
		{
			key: 'secretFingerprint',
			header: t('notifications.webhooks.column.fingerprint'),
			width: '16%',
			value: (subscription) => subscription.secretFingerprint,
			cell: (subscription) =>
				<span class="ui-mono">{subscription.secretFingerprint}</span>,
		},
	];
}

export function WebhooksView(props: WebhooksViewProps) @{
	const client = useMemo(() => createWebhooksClientState(), []);
	const [subscriptions] = useValue(client.state.subscriptions);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [statusFilter, setStatusFilter] = useValue(client.state.statusFilter);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [editorOpen, setEditorOpen] = useValue(client.state.editorOpen);
	const [selectedId, setSelectedId] = useValue(client.state.selectedId);
	const [formSession, setFormSession] = useValue(client.state.formSession);
	const [secret, setSecret] = useValue(client.state.revealedSecret);
	const [confirm, setConfirm] = useValue(client.state.confirm);
	const [pageIndex, setPageIndex] = useState(0);
	const [pageSize, setPageSize] = useState(25);
	const selected =
		subscriptions.find(
			(subscription) => subscription.id === selectedId,
		) ?? null;
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const visible = subscriptions.filter(
		(subscription) =>
			(statusFilter === '' || subscription.status === statusFilter) &&
				(term === '' ||
					subscription.name.toLocaleLowerCase(locale).includes(term) ||
					subscription.url.toLocaleLowerCase(locale).includes(term)),
	);
	const filtered = term !== '' || statusFilter !== '';

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const loaded = await loadWebhooks();
			client.store.act((transaction) => {
				transaction.set(client.state.subscriptions, loaded);
				transaction.set(client.state.status, 'idle');
			}, 'notifications/webhooks-loaded');
		} catch (loadError) {
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

	useEffect(() => {
		void refresh();
	}, []);

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
					count={t('notifications.webhooks.table.count', {
						count: visible.length,
					})}
					search={<SearchField
						value={query}
						placeholder={t('notifications.webhooks.search.placeholder')}
						label={t('notifications.webhooks.search.label')}
						onInput={(value) => {
							setQuery(value);
							setPageIndex(0);
						}}
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
							onChange={(value) => {
								setStatusFilter(value as WebhookSubscriptionStatus | '');
								setPageIndex(0);
							}}
						/>
					</Filters>}
					caption={t('notifications.webhooks.table.caption')}
					columns={columns()}
					rows={visible}
					rowKey={(subscription) => subscription.id}
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
						label={t('notifications.pagination.label')}
						previousLabel={t('notifications.pagination.previous')}
						nextLabel={t('notifications.pagination.next')}
						pageSizeLabel={t('notifications.pagination.size')}
						summary={(range) => t('notifications.pagination.summary', {
							page: range.pageIndex + 1,
							pages: range.pageCount,
							from: range.from,
							to: range.to,
							total: range.totalRows,
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
