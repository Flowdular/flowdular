import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	Drawer,
	Filters,
	Icon,
	PageHeader,
	Pagination,
	SearchField,
	TableCard,
	Tag,
	type TableColumn,
	type TableSort,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import type {
	AutomationSchedule,
	CreateAutomationScheduleInput,
} from '../domain/types.ts';
import {
	createAutomationSchedule,
	deleteAutomationSchedule,
	loadAutomationOptions,
	loadAutomationSchedules,
	runAutomationSchedule,
	updateAutomationSchedule,
} from './api.ts';
import { AutomationScheduleForm } from './AutomationScheduleForm.tsrx';
import {
	AUTOMATION_LIST_PAGE_SIZE,
	FIRST_PAGE,
	createAutomationScheduleClientState,
	listRequest,
	listSort,
	movePage,
	pageLoaded,
} from './state.ts';
import { cadenceLabel, timestampLabel } from './presentation.ts';

export interface AutomationSchedulesViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

/* Keystrokes and page clicks coalesce into one request. */
const LIST_DEBOUNCE_MS = 200;

function ScheduleSummary(props: { readonly schedule: AutomationSchedule }) @{
	<span class="ui-cell">
		<b>{props.schedule.label}</b>
		@if (props.schedule.lastError) {
			<small class="ui-cell__muted">{props.schedule.lastError}</small>
		}
	</span>
}

function scheduleColumns(
	timeZone: string,
): readonly TableColumn<AutomationSchedule>[] {
	return [
		{
			key: 'label',
			header: t('automations.schedules.column.schedule'),
			width: '22%',
			value: (schedule) => schedule.label,
			cell: (schedule) => <ScheduleSummary schedule={schedule} />,
		},
		{
			key: 'target',
			header: t('automations.common.target'),
			width: '16%',
			cell: (schedule) => <span class="ui-cell">
				<span>{schedule.targetName}</span>
				<small class="ui-cell__muted">
					{schedule.targetAvailable
						? t('automations.targetKind.' + schedule.targetKind)
						: t('automations.common.targetUnavailable', {
								kind: t('automations.targetKind.' + schedule.targetKind),
							})}
				</small>
			</span>,
		},
		{
			key: 'cadence',
			header: t('automations.schedules.column.cadence'),
			width: '10%',
			cell: (schedule) => cadenceLabel(schedule.cadence),
		},
		{
			key: 'last-run',
			header: t('automations.schedules.column.lastRun'),
			width: '14%',
			cell: (schedule) => timestampLabel(schedule.lastRunAt, timeZone),
		},
		{
			key: 'next-run',
			header: t('automations.schedules.column.nextRun'),
			width: '14%',
			cell: (schedule) => schedule.enabled
				? timestampLabel(schedule.nextRunAt, timeZone)
				: t('automations.common.paused'),
		},
		{
			key: 'updatedAt',
			header: t('automations.common.updated'),
			width: '12%',
			value: (schedule) => schedule.updatedAt,
			cell: (schedule) => timestampLabel(schedule.updatedAt, timeZone),
		},
		{
			key: 'state',
			header: t('automations.common.state'),
			width: '12%',
			cell: (schedule) =>
				<Tag tone={schedule.enabled ? 'success' : 'neutral'} dot>{t(
					schedule.enabled
						? 'automations.common.enabled'
						: 'automations.common.disabled',
				)}</Tag>,
		},
	];
}

export function AutomationSchedulesView(props: AutomationSchedulesViewProps) @{
	const client = useMemo(() => createAutomationScheduleClientState(), []);
	const requests = useMemo(() => ({ sequence: 0 }), []);
	const [schedules] = useValue(client.state.schedules);
	const [targets] = useValue(client.state.targets);
	const [variables] = useValue(client.state.variables);
	const [timeZone] = useValue(client.state.timeZone);
	const [selectedId, setSelectedId] = useValue(client.state.selectedScheduleId);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [notice, setNotice] = useValue(client.state.notice);
	const [query] = useValue(client.state.query);
	const [enabledOnly] = useValue(client.state.enabledOnly);
	const [sorting] = useValue(client.state.sorting);
	const [paging, setPaging] = useValue(client.state.paging);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [editorOpen, setEditorOpen] = useValue(client.state.editorOpen);
	const selected =
		schedules.find((schedule) => schedule.id === selectedId) ?? null;
	const filtered = query.trim() !== '' || enabledOnly;
	const order = listSort(sorting);

	const loadPage = async () => {
		const sequence = requests.sequence += 1;
		setStatus('loading');
		setError('');
		try {
			const result = await loadAutomationSchedules(
				listRequest({ sorting, query, enabledOnly, paging }),
			);
			if (sequence !== requests.sequence) return;
			client.store.act((transaction) => {
				transaction.set(client.state.schedules, result.items);
				transaction.set(
					client.state.paging,
					pageLoaded(paging, result.page.nextCursor),
				);
			}, 'automation-schedules/page');
		} catch (loadError) {
			if (sequence !== requests.sequence) return;
			setError(
				loadError instanceof Error
					? loadError.message
					: t('automations.schedules.error.load'),
			);
		} finally {
			if (sequence === requests.sequence) setStatus('idle');
		}
	};

	const loadOptions = async () => {
		try {
			const result = await loadAutomationOptions();
			client.store.act((transaction) => {
				transaction.set(client.state.targets, result.targets);
				transaction.set(client.state.variables, result.variables);
				transaction.set(client.state.timeZone, result.timeZone);
			}, 'automation-schedules/options');
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('automations.schedules.error.load'),
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
		'automation-schedules/query',
	);
	const changeEnabledOnly = (value: boolean) => restart(
		(transaction) => transaction.set(client.state.enabledOnly, value),
		'automation-schedules/enabled-only',
	);
	const changeSorting = (value: readonly TableSort[]) => restart(
		(transaction) => transaction.set(client.state.sorting, value),
		'automation-schedules/sorting',
	);
	const changePage = (pageIndex: number) => setPaging(
		movePage(paging, pageIndex),
	);

	const open = (scheduleId: string) => {
		setSelectedId(scheduleId);
		setEditorOpen(true);
	};

	const save = async (input: CreateAutomationScheduleInput) => {
		setStatus('submitting');
		setError('');
		try {
			if (selected) {
				await updateAutomationSchedule(
					{ ...input, id: selected.id },
					props.csrfToken,
				);
			} else {
				await createAutomationSchedule(input, props.csrfToken);
			}
			setEditorOpen(false);
			await refresh();
		} catch (saveError) {
			setError(
				saveError instanceof Error
					? saveError.message
					: t('automations.schedules.error.save'),
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
			await deleteAutomationSchedule(selected.id, props.csrfToken);
			setEditorOpen(false);
			setSelectedId('');
			await refresh();
		} catch (deleteError) {
			setError(
				deleteError instanceof Error
					? deleteError.message
					: t('automations.schedules.error.delete'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const runNow = async (schedule: AutomationSchedule) => {
		setError('');
		setNotice('');
		try {
			const run = await runAutomationSchedule(schedule.id, props.csrfToken);
			setNotice(
				t('automations.schedules.notice.queued', {
					id: run.id,
					label: schedule.label,
				}),
			);
			await loadPage();
		} catch (runError) {
			setError(
				runError instanceof Error
					? runError.message
					: t('automations.schedules.error.run'),
			);
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('automations.common.eyebrow')}
			title={t('automations.schedules.title')}
			description={t('automations.schedules.description')}
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
					{t('automations.schedules.new')}
				</Button>
			}
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		@if (notice) {
			<Alert tone="info">{notice}</Alert>
		}
		<TableCard
			title={t('automations.schedules.table.title')}
			count={t('automations.schedules.table.count', {
				count: schedules.length,
				page: paging.pageIndex + 1,
			})}
			search={<SearchField
				value={query}
				placeholder={t('automations.schedules.search.placeholder')}
				label={t('automations.schedules.search.label')}
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
			columns={scheduleColumns(timeZone)}
			rows={schedules}
			rowKey={(schedule) => schedule.id}
			sorting
			sortingState={sorting}
			onSortingChange={changeSorting}
			pagination={{
				pageIndex: paging.pageIndex,
				pageSize: AUTOMATION_LIST_PAGE_SIZE,
				onPageChange: changePage,
				hasMore: paging.nextCursor !== null,
			}}
			status={status === 'loading' && schedules.length === 0
				? 'loading'
				: 'idle'}
			loadingLabel={t('automations.schedules.loading')}
			empty={{
				icon: 'activity',
				title: t('automations.schedules.empty.title'),
				hint: t('automations.schedules.empty.hint'),
			}}
			filtered={filtered}
			emptyFiltered={{
				icon: 'search',
				title: t('automations.schedules.empty.filteredTitle'),
				hint: t('automations.schedules.empty.filteredHint'),
			}}
			actionsLabel={t('automations.common.actions')}
			actionsWidth="280px"
			actions={props.canManage
				? (schedule) => [
						{
							id: 'run',
							label: t('automations.schedules.runNow'),
							icon: 'play',
							onSelect: () => void runNow(schedule),
						},
						{
							id: 'open',
							label: t('automations.common.edit'),
							icon: 'file-text',
							onSelect: () => open(schedule.id),
						},
					]
				: undefined}
			after={<Pagination
				pageIndex={paging.pageIndex}
				pageSize={AUTOMATION_LIST_PAGE_SIZE}
				hasMore={paging.nextCursor !== null}
				onPageChange={changePage}
				label={t('automations.schedules.pagination.label')}
				previousLabel={t('automations.common.pagination.previous')}
				nextLabel={t('automations.common.pagination.next')}
				summary={(page) => t('automations.common.pagination.summary', {
					page: page.pageIndex + 1,
					from: page.from,
				})}
			/>}
			note={t('automations.schedules.note') + ' ' +
				t('automations.schedules.timeZoneNote', { zone: timeZone })}
			noteIcon="shield"
			caption={t('automations.schedules.table.caption')}
		/>
		<Drawer
			open={editorOpen}
			title={selected ? selected.label : t('automations.schedules.new')}
			subtitle={selected
				? selected.targetName
				: t('automations.schedules.drawer.subtitle')}
			width="lg"
			onClose={() => setEditorOpen(false)}
		>
			<AutomationScheduleForm
				key={selected?.id ?? 'new-schedule'}
				schedule={selected}
				targets={targets}
				variables={variables}
				timeZone={timeZone}
				busy={status === 'submitting'}
				onCancel={() => setEditorOpen(false)}
				onDelete={selected && props.canManage ? () => remove() : undefined}
				onSubmit={save}
			/>
		</Drawer>
	</div>
}
