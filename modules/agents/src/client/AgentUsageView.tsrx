import { useEffect, useMemo } from 'octane';
import { t } from '@flowdular/client';
import {
	Alert,
	Button,
	EmptyState,
	Icon,
	Kpi,
	PageHeader,
	TableCard,
	Tag,
	type TableColumn,
} from '@flowdular/ui';
import { useValue } from 'segment-state';
import type { AgentUsageAgent, AgentUsageDay } from '../domain/types.ts';
import { loadAgentUsage } from './api.ts';
import { costLabel, countLabel, dayLabel, tokenLabel } from './presentation.ts';
import { createAgentUsageClientState } from './state.ts';

function agentColumns(): readonly TableColumn<AgentUsageAgent>[] {
	return [
		{
			key: 'agent',
			header: t('agents.runs.column.agent'),
			width: '30%',
			cell: (row) => <span class="ui-cell">
				<b>{row.agentName}</b>
			</span>,
		},
		{
			key: 'runs',
			header: t('agents.usage.column.runs'),
			width: '12%',
			numeric: true,
			cell: (row) => countLabel(row.runs),
		},
		{
			key: 'input',
			header: t('agents.usage.column.input'),
			width: '14%',
			numeric: true,
			cell: (row) => tokenLabel(row.inputTokens),
		},
		{
			key: 'output',
			header: t('agents.usage.column.output'),
			width: '14%',
			numeric: true,
			cell: (row) => tokenLabel(row.outputTokens),
		},
		{
			key: 'cost',
			header: t('agents.usage.column.cost'),
			width: '14%',
			numeric: true,
			cell: (row) => costLabel(row.costMicroUsd),
		},
		{
			key: 'pricing',
			header: t('agents.usage.column.pricing'),
			width: '16%',
			cell: (row) => row.unpricedRuns > 0
				? <Tag tone="warning" dot>{t('agents.usage.unpriced', {
						count: row.unpricedRuns,
					})}</Tag>
				: <Tag tone="success" dot>{t('agents.usage.priced')}</Tag>,
		},
	];
}

function dayColumns(): readonly TableColumn<AgentUsageDay>[] {
	return [
		{
			key: 'day',
			header: t('agents.usage.column.day'),
			width: '28%',
			cell: (row) => <span class="ui-mono">{dayLabel(row.day)}</span>,
		},
		{
			key: 'runs',
			header: t('agents.usage.column.runs'),
			width: '18%',
			numeric: true,
			cell: (row) => countLabel(row.runs),
		},
		{
			key: 'input',
			header: t('agents.usage.column.input'),
			width: '18%',
			numeric: true,
			cell: (row) => tokenLabel(row.inputTokens),
		},
		{
			key: 'output',
			header: t('agents.usage.column.output'),
			width: '18%',
			numeric: true,
			cell: (row) => tokenLabel(row.outputTokens),
		},
		{
			key: 'cost',
			header: t('agents.usage.column.cost'),
			width: '18%',
			numeric: true,
			cell: (row) => costLabel(row.costMicroUsd),
		},
	];
}

export function AgentUsageView() @{
	const client = useMemo(() => createAgentUsageClientState(), []);
	const [summary, setSummary] = useValue(client.state.summary);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [days] = useValue(client.state.days);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			setSummary(await loadAgentUsage(days));
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('agents.usage.error.load'),
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const cap = summary?.caps.monthlyCostMicroUsd ?? 0;
	const spent = summary?.month.costMicroUsd ?? 0;
	const remaining = Math.max(0, cap - spent);
	const unpriced = summary?.month.unpricedRuns ?? 0;

	<div class="ui-view">
		<PageHeader
			eyebrow={t('agents.usage.eyebrow')}
			title={t('agents.usage.title')}
			description={t('agents.usage.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('agents.common.refreshing')
					: t('agents.common.refresh')}
			</Button>
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		@if (summary) {
			<>
				<div class="ui-kpi-grid">
					<Kpi
						label={t('agents.usage.kpi.month')}
						value={costLabel(spent)}
						note={t('agents.usage.since', {
							date: dayLabel(summary.month.from),
						})}
					/>
					<Kpi
						label={t('agents.usage.kpi.monthlyBudget')}
						value={cap === 0 ? t('agents.usage.none') : costLabel(cap)}
						note={cap === 0
							? t('agents.usage.setCap')
							: t('agents.usage.left', { amount: costLabel(remaining) })}
					/>
					<Kpi
						label={t('agents.usage.kpi.agentBudget')}
						value={summary.caps.agentMonthlyCostMicroUsd === 0
							? t('agents.usage.none')
							: costLabel(summary.caps.agentMonthlyCostMicroUsd)}
						note={t('agents.usage.agentBudgetNote')}
					/>
					<Kpi
						label={t('agents.usage.kpi.runs')}
						value={countLabel(summary.month.runs)}
						note={unpriced > 0
							? t('agents.usage.unpriced', { count: unpriced })
							: t('agents.usage.allPriced')}
					/>
				</div>
				<TableCard
					title={t('agents.usage.byAgent.title')}
					count={t('agents.usage.range', {
						from: dayLabel(summary.from),
						to: dayLabel(summary.to),
					})}
					columns={agentColumns()}
					rows={summary.agents}
					rowKey={(row) => row.agentId}
					empty={{
						icon: 'bot',
						title: t('agents.usage.byAgent.emptyTitle'),
						hint: t('agents.usage.byAgent.emptyHint'),
					}}
					note={t('agents.usage.note')}
					noteIcon="shield"
					caption={t('agents.usage.byAgent.caption')}
				/>
				<TableCard
					title={t('agents.usage.byDay.title')}
					count={t('agents.usage.byDay.count', {
						count: summary.days.length,
					})}
					columns={dayColumns()}
					rows={summary.days}
					rowKey={(row) => row.day}
					empty={{
						icon: 'activity',
						title: t('agents.usage.byDay.emptyTitle'),
						hint: t('agents.usage.byDay.emptyHint'),
					}}
					caption={t('agents.usage.byDay.caption')}
				/>
			</>
		} @else if (status !== 'loading') {
			<section class="ui-card">
				<EmptyState
					icon="activity"
					title={t('agents.usage.unavailableTitle')}
				>{t('agents.usage.unavailableHint')}</EmptyState>
			</section>
		}
	</div>
}
