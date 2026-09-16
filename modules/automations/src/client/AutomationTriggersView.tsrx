import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	CellMuted,
	CellNumber,
	CellStack,
	CellTag,
	CellTime,
	Drawer,
	Filters,
	Icon,
	PageHeader,
	Pagination,
	SearchField,
	TableCard,
	type TableColumn,
	type TableSort,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import type { AutomationTrigger } from '../domain/types.ts';
import {
	createAutomationTrigger,
	deleteAutomationTrigger,
	loadAutomationTriggerOptions,
	loadAutomationTriggers,
	rotateAutomationTrigger,
	updateAutomationTrigger,
} from './api.ts';
import type { AutomationTriggerFormValue } from './AutomationTriggerForm.tsrx';
import { AutomationTriggerForm } from './AutomationTriggerForm.tsrx';
import {
	AUTOMATION_LIST_PAGE_SIZE,
	FIRST_PAGE,
	createAutomationTriggerClientState,
	listRequest,
	listSort,
	movePage,
	pageLoaded,
} from './state.ts';

export interface AutomationTriggersViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

/* Keystrokes and page clicks coalesce into one request. */
const LIST_DEBOUNCE_MS = 200;

/* The trigger and its state stay on screen; the target, the last call and
   the counts hide next, the update time first. */
function triggerColumns(): readonly TableColumn<AutomationTrigger>[] {
	return [
		{
			key: 'label',
			header: t('automations.triggers.column.trigger'),
			width: 'auto',
			value: (trigger) => trigger.label,
			cell: (trigger) => <CellStack
				primary={trigger.label}
				secondary={t('automations.triggers.secretRevision', {
					revision: trigger.secretRevision,
				})}
				secondaryMono
			/>,
		},
		{
			key: 'target',
			header: t('automations.common.target'),
			width: '180px',
			priority: 2,
			cell: (trigger) => <CellStack
				primary={trigger.targetName}
				secondary={trigger.targetAvailable
					? t('automations.targetKind.' + trigger.targetKind)
					: t('automations.common.targetUnavailable', {
							kind: t('automations.targetKind.' + trigger.targetKind),
						})}
			/>,
		},
		{
			key: 'last-fired',
			header: t('automations.triggers.column.lastFired'),
			width: '170px',
			priority: 2,
			cell: (trigger) => trigger.lastFiredAt === null
				? <CellMuted>{t('automations.common.notYet')}</CellMuted>
				: <CellTime value={trigger.lastFiredAt} />,
		},
		{
			key: 'accepted',
			header: t('automations.triggers.column.accepted'),
			width: '110px',
			numeric: true,
			priority: 2,
			cell: (trigger) => <CellNumber value={trigger.acceptedCount} />,
		},
		{
			key: 'rejected',
			header: t('automations.triggers.column.rejected'),
			width: '110px',
			numeric: true,
			priority: 2,
			cell: (trigger) => <CellNumber value={trigger.rejectedCount} />,
		},
		{
			key: 'updatedAt',
			header: t('automations.common.updated'),
			width: '170px',
			priority: 3,
			value: (trigger) => trigger.updatedAt,
			cell: (trigger) => <CellTime value={trigger.updatedAt} />,
		},
		{
			key: 'state',
			header: t('automations.common.state'),
			width: '120px',
			cell: (trigger) =>
				<CellTag
					tone={trigger.enabled ? 'success' : 'neutral'}
					dot
					label={t(
						trigger.enabled
							? 'automations.common.enabled'
							: 'automations.common.disabled',
					)}
				/>,
		},
	];
}

export function AutomationTriggersView(props: AutomationTriggersViewProps) @{
	const client = useMemo(() => createAutomationTriggerClientState(), []);
	const requests = useMemo(() => ({ sequence: 0 }), []);
	const [triggers] = useValue(client.state.triggers);
	const [targets] = useValue(client.state.targets);
	const [selectedId, setSelectedId] = useValue(client.state.selectedTriggerId);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query] = useValue(client.state.query);
	const [enabledOnly] = useValue(client.state.enabledOnly);
	const [sorting] = useValue(client.state.sorting);
	const [paging, setPaging] = useValue(client.state.paging);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [editorOpen, setEditorOpen] = useValue(client.state.editorOpen);
	const [secret, setSecret] = useValue(client.state.revealedSecret);
	const selected =
		triggers.find((trigger) => trigger.id === selectedId) ?? null;
	const filtered = query.trim() !== '' || enabledOnly;
	const order = listSort(sorting);

	const loadPage = async () => {
		const sequence = requests.sequence += 1;
		setStatus('loading');
		setError('');
		try {
			const result = await loadAutomationTriggers(
				listRequest({ sorting, query, enabledOnly, paging }),
			);
			if (sequence !== requests.sequence) return;
			client.store.act((transaction) => {
				transaction.set(client.state.triggers, result.items);
				transaction.set(
					client.state.paging,
					pageLoaded(paging, result.page.nextCursor),
				);
			}, 'automation-triggers/page');
		} catch (loadError) {
			if (sequence !== requests.sequence) return;
			setError(
				loadError instanceof Error
					? loadError.message
					: t('automations.triggers.error.load'),
			);
		} finally {
			if (sequence === requests.sequence) setStatus('idle');
		}
	};

	const loadOptions = async () => {
		try {
			const result = await loadAutomationTriggerOptions();
			client.store.act((transaction) => {
				transaction.set(client.state.targets, result.targets);
			}, 'automation-triggers/options');
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('automations.triggers.error.load'),
			);
		}
	};

	const refresh = async () => {
		await Promise.all([loadOptions(), loadPage()]);
	};

	useEffect(() => {
		void loadOptions();
	}, []);

	useEffect(() => {
		const handle = setTimeout(() => void loadPage(), LIST_DEBOUNCE_MS);
		return () => clearTimeout(handle);
	}, [query, enabledOnly, order.sort, order.direction, paging.pageIndex]);

	/* A narrower or reordered list starts from its first page. */
	const restart = (
		change: Parameters<typeof client.store.act>[0],
		label: string,
	) => {
		client.store.act((transaction) => {
			change(transaction);
			transaction.set(client.state.paging, FIRST_PAGE);
		}, label);
	};
	const changeQuery = (value: string) => restart(
		(transaction) => transaction.set(client.state.query, value),
		'automation-triggers/query',
	);
	const changeEnabledOnly = (value: boolean) => restart(
		(transaction) => transaction.set(client.state.enabledOnly, value),
		'automation-triggers/enabled-only',
	);
	const changeSorting = (value: readonly TableSort[]) => restart(
		(transaction) => transaction.set(client.state.sorting, value),
		'automation-triggers/sorting',
	);
	const changePage = (pageIndex: number) => setPaging(
		movePage(paging, pageIndex),
	);

	const open = (triggerId: string) => {
		setSecret('');
		setSelectedId(triggerId);
		setEditorOpen(true);
	};

	const close = () => {
		setSecret('');
		setEditorOpen(false);
	};

	const save = async (value: AutomationTriggerFormValue) => {
		setStatus('submitting');
		setError('');
		try {
			if (selected) {
				await updateAutomationTrigger(selected.id, value, props.csrfToken);
				setEditorOpen(false);
			} else {
				const created = await createAutomationTrigger(value, props.csrfToken);
				client.store.act((transaction) => {
					transaction.set(client.state.selectedTriggerId, created.trigger.id);
					transaction.set(client.state.revealedSecret, created.secret);
				}, 'automation-triggers/created');
			}
			await refresh();
		} catch (saveError) {
			setError(
				saveError instanceof Error
					? saveError.message
					: t('automations.triggers.error.save'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const rotate = async () => {
		if (!selected) return;
		setStatus('submitting');
		setError('');
		try {
			const rotated = await rotateAutomationTrigger(
				selected.id,
				props.csrfToken,
			);
			setSecret(rotated.secret);
			await loadPage();
		} catch (rotateError) {
			setError(
				rotateError instanceof Error
					? rotateError.message
					: t('automations.triggers.error.rotate'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const remove = async () => {
		if (!selected) return;
		setStatus('submitting');
		setError('');
		try {
			await deleteAutomationTrigger(selected.id, props.csrfToken);
			setSelectedId('');
			close();
			await refresh();
		} catch (deleteError) {
			setError(
				deleteError instanceof Error
					? deleteError.message
					: t('automations.triggers.error.delete'),
			);
		} finally {
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('automations.common.eyebrow')}
			title={t('automations.triggers.title')}
			description={t('automations.triggers.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('automations.common.refreshing')
					: t('automations.common.refresh')}
			</Button>
			@if (props.canManage) {
				<Button size="sm" variant="primary" onClick={() => open('')}>
					<Icon name="plus" size={14} />
					{t('automations.triggers.new')}
				</Button>
			}
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<TableCard
			title={t('automations.triggers.table.title')}
			count={t('automations.triggers.table.count', {
				count: triggers.length,
				page: paging.pageIndex + 1,
			})}
			search={<SearchField
				value={query}
				placeholder={t('automations.triggers.search.placeholder')}
				label={t('automations.triggers.search.label')}
				onInput={changeQuery}
			/>}
			filters={<Filters
				open={filtersOpen}
				onToggle={() => setFiltersOpen(!filtersOpen)}
				activeCount={enabledOnly ? 1 : 0}
				label={t('automations.common.filters')}
			>
				<label class="ui-checkbox">
					<input
						type="checkbox"
						checked={enabledOnly}
						onChange={(event: Event) => changeEnabledOnly(
							(event.currentTarget as HTMLInputElement).checked,
						)}
					/>
					<span>{t('automations.common.enabledOnly')}</span>
				</label>
			</Filters>}
			mode="server"
			columns={triggerColumns()}
			rows={triggers}
			rowKey={(trigger) => trigger.id}
			sorting
			sortingState={sorting}
			onSortingChange={changeSorting}
			pagination={{
				pageIndex: paging.pageIndex,
				pageSize: AUTOMATION_LIST_PAGE_SIZE,
				onPageChange: changePage,
				hasMore: paging.nextCursor !== null,
			}}
			status={status === 'loading' && triggers.length === 0
				? 'loading'
				: 'idle'}
			loadingLabel={t('automations.triggers.loading')}
			empty={{
				icon: 'plug',
				title: t('automations.triggers.empty.title'),
				hint: t('automations.triggers.empty.hint'),
			}}
			filtered={filtered}
			emptyFiltered={{
				icon: 'search',
				title: t('automations.triggers.empty.filteredTitle'),
				hint: t('automations.triggers.empty.filteredHint'),
			}}
			actionsLabel={t('automations.common.actions')}
			actions={props.canManage
				? (trigger) => [
						{
							id: 'open',
							label: t('automations.common.edit'),
							icon: 'file-text',
							onSelect: () => open(trigger.id),
						},
					]
				: undefined}
			after={<Pagination
				pageIndex={paging.pageIndex}
				pageSize={AUTOMATION_LIST_PAGE_SIZE}
				hasMore={paging.nextCursor !== null}
				onPageChange={changePage}
				label={t('automations.triggers.pagination.label')}
				previousLabel={t('automations.common.pagination.previous')}
				nextLabel={t('automations.common.pagination.next')}
				summary={(page) => t('automations.common.pagination.summary', {
					page: page.pageIndex + 1,
					from: page.from,
				})}
			/>}
			note={t('automations.triggers.note')}
			noteIcon="shield"
			caption={t('automations.triggers.table.caption')}
		/>
		<Drawer
			open={editorOpen}
			title={selected ? selected.label : t('automations.triggers.new')}
			subtitle={selected
				? selected.targetName
				: t('automations.triggers.drawer.subtitle')}
			width="lg"
			onClose={close}
		>
			<AutomationTriggerForm
				key={selected?.id ?? 'new-trigger'}
				trigger={selected}
				targets={targets}
				busy={status === 'submitting'}
				secret={secret}
				onCancel={close}
				onRotate={selected && props.canManage ? () => rotate() : undefined}
				onDelete={selected && props.canManage ? () => remove() : undefined}
				onSubmit={save}
			/>
		</Drawer>
	</div>
}
