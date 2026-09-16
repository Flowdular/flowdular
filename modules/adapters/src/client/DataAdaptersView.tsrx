import { useEffect, useState } from 'octane';
import {
	Alert,
	Button,
	EmptyState,
	Icon,
	PageHeader,
	TableCard,
	Tag,
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
import {
	countLabel,
	statusLabel,
	statusTone,
	timestampLabel,
} from './presentation.ts';

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
			width: '24%',
			value: (adapter) => adapter.label,
			cell: (adapter) => <span class="ui-cell">
				<b>{adapter.label}</b>
				<small class="ui-cell__muted ui-mono">{adapter.moduleId}</small>
			</span>,
		},
		{
			key: 'direction',
			header: t('adapters.column.direction'),
			width: '10%',
			value: (adapter) => adapter.direction,
			cell: (adapter) =>
				<Tag tone={adapter.direction === 'source' ? 'info' : 'ink'}>{t(
					'adapters.direction.' + adapter.direction,
				)}</Tag>,
		},
		{
			key: 'target',
			header: t('adapters.column.target'),
			width: '18%',
			value: (adapter) => adapter.port,
			cell: (adapter) => <span class="ui-cell">
				<span class="ui-mono">{adapter.port}</span>
				<small class="ui-cell__muted">
					{adapter.target.available
						? adapter.target.label ?? ''
						: t('adapters.target.unavailable')}
				</small>
			</span>,
		},
		{
			key: 'instance',
			header: t('adapters.column.instance'),
			width: '14%',
			value: (adapter) => adapter.binding?.instanceId ?? '',
			cell: (adapter) => adapter.binding?.instanceId
				? <span class="ui-mono">{adapter.binding.instanceId}</span>
				: adapter.recorded
					? <Tag tone="warning">{t('adapters.instance.recorded')}</Tag>
					: <span class="ui-cell__muted">{t('adapters.instance.none')}</span>,
		},
		{
			key: 'schedule',
			header: t('adapters.column.schedule'),
			width: '14%',
			value: (adapter) => scheduleOf(adapter) ?? '',
			cell: (adapter) => <span class="ui-cell">
				<span class="ui-mono">
					{scheduleOf(adapter) ?? t('adapters.schedule.onDemand')}
				</span>
				<small class="ui-cell__muted">
					{adapter.binding?.enabled
						? t('adapters.common.enabled')
						: t('adapters.common.disabled')}
				</small>
			</span>,
		},
		{
			key: 'lastRun',
			header: t('adapters.column.lastRun'),
			width: '20%',
			value: (adapter) => adapter.lastRun?.queuedAt ?? 0,
			cell: (adapter) => adapter.lastRun
				? <span class="ui-cell">
						<span>
							<Tag tone={statusTone(adapter.lastRun.status)} dot>{statusLabel(
								adapter.lastRun.status,
							)}</Tag>
						</span>
						<small class="ui-cell__muted">
							{t('adapters.lastRun.counts', {
								read: countLabel(adapter.lastRun.rowsRead),
								written: countLabel(
									adapter.lastRun.rowsCreated + adapter.lastRun.rowsUpdated,
								),
								failed: countLabel(adapter.lastRun.rowsFailed),
							})}
							{' · '}
							{timestampLabel(adapter.lastRun.queuedAt)}
						</small>
					</span>
				: <span class="ui-cell__muted">{t('adapters.lastRun.never')}</span>,
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
