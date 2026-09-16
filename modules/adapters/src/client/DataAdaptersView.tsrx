import { useEffect, useState } from 'octane';
import {
	Alert,
	Button,
	CellCode,
	CellMuted,
	CellStack,
	CellTag,
	CellText,
	CellTime,
	EmptyState,
	Icon,
	PageHeader,
	TableCard,
	ToastHost,
	toasts,
	type TableAction,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client/i18n';
import {
	adaptersErrorMessage,
	AdaptersApiError,
	loadAdapters,
	startRun,
	type AdapterListItem,
} from './api.ts';
import { AdapterBindingDrawer } from './AdapterBindingDrawer.tsrx';
import { AdapterRunsDrawer } from './AdapterRunsDrawer.tsrx';
import { countLabel, statusLabel, statusTone } from './presentation.ts';

export interface DataAdaptersViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

type ScreenStatus = 'loading' | 'idle' | 'error' | 'denied';

function scheduleOf(adapter: AdapterListItem): string | null {
	const override = adapter.binding?.schedule ?? null;
	if (override === null) return adapter.schedule;
	return override === '' ? null : override;
}

function columns(): readonly TableColumn<AdapterListItem>[] {
	return [
		{
			key: 'adapter',
			header: t('adapters.column.adapter'),
			width: 'auto',
			value: (adapter) => adapter.label,
			cell: (adapter) =>
				<CellStack
					primary={adapter.label}
					secondary={adapter.moduleId}
					secondaryMono
				/>,
		},
		{
			key: 'direction',
			header: t('adapters.column.direction'),
			width: '120px',
			priority: 2,
			value: (adapter) => adapter.direction,
			cell: (adapter) =>
				<CellTag
					tone={adapter.direction === 'source' ? 'info' : 'ink'}
					label={t('adapters.direction.' + adapter.direction)}
				/>,
		},
		{
			key: 'target',
			header: t('adapters.column.target'),
			width: '200px',
			priority: 2,
			value: (adapter) => adapter.port,
			cell: (adapter) =>
				<CellStack
					primary={adapter.port}
					primaryMono
					secondary={adapter.target.available
						? adapter.target.label ?? ''
						: t('adapters.target.unavailable')}
				/>,
		},
		{
			key: 'instance',
			header: t('adapters.column.instance'),
			width: '170px',
			priority: 3,
			value: (adapter) => adapter.binding?.instanceId ?? '',
			cell: (adapter) => adapter.binding?.instanceId
				? <CellCode value={adapter.binding.instanceId} />
				: adapter.recorded
					? <CellTag tone="warning" label={t('adapters.instance.recorded')} />
					: <CellMuted>{t('adapters.instance.none')}</CellMuted>,
		},
		{
			key: 'schedule',
			header: t('adapters.column.schedule'),
			width: '160px',
			priority: 2,
			value: (adapter) => scheduleOf(adapter) ?? '',
			cell: (adapter) =>
				<CellStack
					primary={scheduleOf(adapter) ?? t('adapters.schedule.onDemand')}
					primaryMono
					secondary={adapter.binding?.enabled
						? t('adapters.common.enabled')
						: t('adapters.common.disabled')}
				/>,
		},
		{
			key: 'lastRun',
			header: t('adapters.column.lastRun'),
			width: '170px',
			value: (adapter) => adapter.lastRun?.queuedAt ?? 0,
			cell: (adapter) => adapter.lastRun
				? <CellStack
						primary={<CellTag
							tone={statusTone(adapter.lastRun.status)}
							dot
							label={statusLabel(adapter.lastRun.status)}
						/>}
						secondary={<CellTime value={adapter.lastRun.queuedAt} />}
					/>
				: <CellMuted>{t('adapters.lastRun.never')}</CellMuted>,
		},
		{
			key: 'lastRunRows',
			header: t('adapters.column.lastRunRows'),
			width: '220px',
			priority: 3,
			cell: (adapter) => adapter.lastRun
				? <CellText
						value={t('adapters.lastRun.counts', {
							read: countLabel(adapter.lastRun.rowsRead),
							written: countLabel(
								adapter.lastRun.rowsCreated + adapter.lastRun.rowsUpdated,
							),
							failed: countLabel(adapter.lastRun.rowsFailed),
						})}
						wrap
					/>
				: null,
		},
	];
}

export function DataAdaptersView(props: DataAdaptersViewProps) @{
	const [adapters, setAdapters] = useState<readonly AdapterListItem[]>([]);
	const [status, setStatus] = useState<ScreenStatus>('loading');
	const [error, setError] = useState('');
	const [configuring, setConfiguring] = useState<AdapterListItem | null>(null);
	const [inspecting, setInspecting] = useState<AdapterListItem | null>(null);
	const [starting, setStarting] = useState('');

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			setAdapters(await loadAdapters());
			setStatus('idle');
		} catch (failure) {
			setError(adaptersErrorMessage(failure, 'adapters.error.load'));
			setStatus(
				failure instanceof AdaptersApiError &&
				(failure.code === 'FORBIDDEN' || failure.code === 'MODULE_INACTIVE')
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const runNow = async (adapter: AdapterListItem) => {
		setStarting(adapter.id);
		try {
			await startRun(adapter.id, props.csrfToken);
			toasts.success(t('adapters.notice.started', { label: adapter.label }));
			await refresh();
		} catch (failure) {
			toasts.error(adaptersErrorMessage(failure, 'adapters.error.start'));
		} finally {
			setStarting('');
		}
	};

	const actions = (adapter: AdapterListItem): readonly TableAction[] => [
		{
			id: 'runs',
			label: t('adapters.action.runs'),
			icon: 'activity',
			onSelect: () => setInspecting(adapter),
		},
		...(props.canManage
			? [
					{
						id: 'configure',
						label: t('adapters.action.configure'),
						icon: 'settings',
						onSelect: () => setConfiguring(adapter),
					},
					{
						id: 'run',
						label: t('adapters.action.runNow'),
						icon: 'play',
						disabled: !adapter.binding?.enabled || starting !== '',
						reason: adapter.binding?.enabled
							? undefined
							: t('adapters.action.runNowDisabled'),
						onSelect: () => void runNow(adapter),
					},
				]
			: []),
	];

	<div class="ui-view">
		<PageHeader
			eyebrow={t('adapters.page.eyebrow')}
			title={t('adapters.page.title')}
			description={t('adapters.page.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh()}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('adapters.common.refreshing')
					: t('adapters.common.refresh')}
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('adapters.denied.title')}>{t(
					'adapters.denied.hint',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (status === 'error') {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('adapters.table.title')}
					count={t('adapters.table.count', { count: adapters.length })}
					caption={t('adapters.table.caption')}
					columns={columns()}
					rows={adapters}
					rowKey={(adapter) => adapter.id}
					sorting
					status={status === 'loading' && adapters.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('adapters.table.loading')}
					empty={{
						icon: 'plug',
						title: t('adapters.empty.title'),
						hint: t('adapters.empty.hint'),
					}}
					actions={actions}
					actionsLabel={t('adapters.common.actions')}
					actionsWidth="200px"
					noteIcon="shield"
					note={t('adapters.table.note')}
				/>
			</>
		}
		<AdapterBindingDrawer
			open={configuring !== null}
			adapter={configuring}
			csrfToken={props.csrfToken}
			onClose={() => setConfiguring(null)}
			onSaved={() => {
				setConfiguring(null);
				toasts.success(t('adapters.notice.saved'));
				void refresh();
			}}
		/>
		<AdapterRunsDrawer
			open={inspecting !== null}
			adapter={inspecting}
			csrfToken={props.csrfToken}
			canManage={props.canManage}
			onClose={() => {
				setInspecting(null);
				void refresh();
			}}
		/>
		<ToastHost
			label={t('adapters.common.messages')}
			closeLabel={t('adapters.common.close')}
		/>
	</div>
}
