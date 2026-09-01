import { useEffect, useMemo } from 'octane';
import { Alert, Button, EmptyState, Icon, PageHeader, Tag } from '@coreloom/ui';
import { useValue } from 'segment-state';
import type { AgentRun } from '../domain/types.ts';
import {
	cancelAgentRun,
	loadAgentRun,
	loadAgentRuns,
	observeAgentRun,
} from './api.ts';
import { stateTone } from './presentation.ts';
import { RunTimeline } from './RunTimeline.tsrx';
import { createAgentClientState } from './state.ts';

export interface AgentRunsViewProps {
	readonly csrfToken: string;
	readonly canCancel: boolean;
}

function date(value: number): string {
	return new Intl.DateTimeFormat('en', {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(value);
}

/* Elapsed since start; live while the run has no end, blank before it starts. */
function duration(run: AgentRun, now: number): string {
	if (run.startedAt === null) return '';
	const seconds = Math.max(
		0,
		((run.completedAt ?? now) - run.startedAt) / 1000,
	);
	if (seconds < 60) return seconds.toFixed(seconds < 10 ? 1 : 0) + ' s';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return minutes + ' min ' + Math.round(seconds % 60) + ' s';
	return Math.floor(minutes / 60) + ' h ' + minutes % 60 + ' min';
}

export function AgentRunsView(props: AgentRunsViewProps) @{
	const client = useMemo(() => createAgentClientState(), []);
	const [runs] = useValue(client.state.runs);
	const [selectedRun, setSelectedRun] = useValue(client.state.selectedRun);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);

	const open = async (run: AgentRun) => {
		try {
			setSelectedRun(await loadAgentRun(run.id));
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: 'Could not load the run.',
			);
		}
	};

	const cancel = async () => {
		if (!selectedRun) return;
		setStatus('submitting');
		setError('');
		try {
			setSelectedRun(await cancelAgentRun(selectedRun.id, props.csrfToken));
		} catch (cancelError) {
			setError(
				cancelError instanceof Error
					? cancelError.message
					: 'Could not cancel the run.',
			);
		} finally {
			setStatus('idle');
		}
	};

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const records = await loadAgentRuns();
			client.store.act(
				(transaction) => transaction.set(client.state.runs, records),
				'agents/runs-loaded',
			);
			if (selectedRun) {
				setSelectedRun(await loadAgentRun(selectedRun.id));
			}
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: 'Could not load agent runs.',
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), 2_500);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		if (
			!selectedRun ||
				['succeeded', 'failed', 'cancelled'].includes(selectedRun.status)
		) {
			return;
		}
		return observeAgentRun(selectedRun.id, setSelectedRun, selectedRun.events);
	}, [selectedRun?.id, selectedRun?.status]);

	const now = Date.now();

	<div class="ui-view">
		<PageHeader
			eyebrow="Durable execution"
			title="Agent runs"
			description="Inspect queued, running, completed, and failed work across the active tenant."
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{status === 'loading' ? 'Refreshing…' : 'Refresh'}
			</Button>
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<div class="ui-two-col ui-two-col--wide-aside">
			<section class="ui-card">
				<div class="ui-card__head">
					<span class="ui-card__title">
						Execution queue
						<small>{runs.length + ' recent runs'}</small>
					</span>
				</div>
				@if (runs.length === 0) {
					<EmptyState icon="play" title="No runs yet">
						Queue a playground run to verify the worker path.
					</EmptyState>
				} @else {
					<div class="ui-table-wrap">
						<table class="ui-table" aria-label="Agent runs">
							<thead>
								<tr>
									<th>Agent</th>
									<th>Trigger</th>
									<th>Queued</th>
									<th class="num">Duration</th>
									<th>Status</th>
									<th class="ui-table__actions"></th>
								</tr>
							</thead>
							<tbody>
								@for (const run of runs; key run.id) {
									<tr
										class={[
											'is-clickable',
											selectedRun?.id === run.id && 'is-selected',
										]}
										aria-selected={selectedRun?.id === run.id}
										onClick={(event: MouseEvent) => {
											if ((event.target as Element).closest('button')) return;
											void open(run);
										}}
									>
										<td>
											<span class="ui-cell">
												<b>{run.agentName}</b>
												<small class="ui-mono">{'r' + run.agentRevision}</small>
											</span>
										</td>
										<td class="ui-cell__muted">{run.trigger}</td>
										<td class="ui-cell__muted">{date(run.queuedAt)}</td>
										<td class="num">{duration(run, now)}</td>
										<td>
											<Tag tone={stateTone(run.status)} dot>{run.status}</Tag>
										</td>
										<td class="ui-table__actions">
											<Button size="sm" onClick={() => void open(run)}>
												View
											</Button>
										</td>
									</tr>
								}
							</tbody>
						</table>
					</div>
				}
			</section>
			@if (selectedRun) {
				<RunTimeline
					run={selectedRun}
					onCancel={props.canCancel ? () => void cancel() : undefined}
					cancelling={status === 'submitting'}
				/>
			} @else {
				<aside class="ui-card">
					<EmptyState icon="activity" title="Trace inspection">
						Select a run to see every provider and tool event in persisted
						order.
					</EmptyState>
				</aside>
			}
		</div>
	</div>
}
