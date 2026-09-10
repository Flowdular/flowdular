import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	Drawer,
	Filters,
	Icon,
	PageHeader,
	SearchField,
	TableCard,
	Tag,
	type TableColumn,
} from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import { useValue } from 'segment-state';
import { cadenceMinutes } from '../domain/cadence.ts';
import type {
	AutomationSchedule,
	CreateAutomationScheduleInput,
} from '../domain/types.ts';
import {
	createAutomationSchedule,
	deleteAutomationSchedule,
	loadAutomationSchedules,
	runAutomationSchedule,
	updateAutomationSchedule,
} from './api.ts';
import { AutomationScheduleForm } from './AutomationScheduleForm.tsrx';
import { createAutomationScheduleClientState } from './state.ts';
import { cadenceLabel, timestampLabel } from './presentation.ts';

export interface AutomationSchedulesViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

function ScheduleSummary(props: { readonly schedule: AutomationSchedule }) @{
	<span class="ui-cell">
		<b>{props.schedule.label}</b>
		@if (props.schedule.lastError) {
			<small class="ui-cell__muted">{props.schedule.lastError}</small>
		}
	</span>
}

function scheduleColumns(): readonly TableColumn<AutomationSchedule>[] {
	return [
		{
			key: 'schedule',
			header: t('automations.schedules.column.schedule'),
			width: '24%',
			cell: (schedule) => <ScheduleSummary schedule={schedule} />,
		},
		{
			key: 'target',
			header: t('automations.common.target'),
			width: '18%',
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
			width: '12%',
			cell: (schedule) => cadenceLabel(cadenceMinutes(schedule.cadence)),
		},
		{
			key: 'last-run',
			header: t('automations.schedules.column.lastRun'),
			width: '16%',
			cell: (schedule) => timestampLabel(schedule.lastRunAt),
		},
		{
			key: 'next-run',
			header: t('automations.schedules.column.nextRun'),
			width: '16%',
			cell: (schedule) => schedule.enabled
				? timestampLabel(schedule.nextRunAt)
				: t('automations.common.paused'),
		},
		{
			key: 'state',
			header: t('automations.common.state'),
			width: '14%',
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
	const [schedules] = useValue(client.state.schedules);
	const [targets] = useValue(client.state.targets);
	const [variables] = useValue(client.state.variables);
	const [selectedId, setSelectedId] = useValue(client.state.selectedScheduleId);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [notice, setNotice] = useValue(client.state.notice);
	const [query, setQuery] = useValue(client.state.query);
	const [enabledOnly, setEnabledOnly] = useValue(client.state.enabledOnly);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [editorOpen, setEditorOpen] = useValue(client.state.editorOpen);
	const selected =
		schedules.find((schedule) => schedule.id === selectedId) ?? null;
	const term = query.trim().toLocaleLowerCase(activeLocale());
	const visible = schedules.filter(
		(schedule) =>
			(!enabledOnly || schedule.enabled) &&
				(term === '' ||
					schedule.label.toLocaleLowerCase(activeLocale()).includes(term) ||
					schedule.targetName.toLocaleLowerCase(activeLocale()).includes(term)),
	);
	const filtered = term !== '' || enabledOnly;

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const result = await loadAutomationSchedules();
			client.store.act((transaction) => {
				transaction.set(client.state.schedules, result.schedules);
				transaction.set(client.state.targets, result.targets);
				transaction.set(client.state.variables, result.variables);
			}, 'automation-schedules/loaded');
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('automations.schedules.error.load'),
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

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
			await refresh();
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
				enabled: schedules.filter((schedule) => schedule.enabled).length,
				total: schedules.length,
			})}
			search={<SearchField
				value={query}
				placeholder={t('automations.schedules.search.placeholder')}
				label={t('automations.schedules.search.label')}
				onInput={setQuery}
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
						onChange={(event: Event) => setEnabledOnly(
							(event.currentTarget as HTMLInputElement).checked,
						)}
					/>
					<span>{t('automations.common.enabledOnly')}</span>
				</label>
			</Filters>}
			columns={scheduleColumns()}
			rows={visible}
			rowKey={(schedule) => schedule.id}
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
			note={t('automations.schedules.note')}
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
				busy={status === 'submitting'}
				onCancel={() => setEditorOpen(false)}
				onDelete={selected && props.canManage ? () => remove() : undefined}
				onSubmit={save}
			/>
		</Drawer>
	</div>
}
