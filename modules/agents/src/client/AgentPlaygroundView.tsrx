import { useEffect, useMemo } from 'octane';
import { Alert, Button, EmptyState, FormField, PageHeader } from '@coreloom/ui';
import { useValue } from 'segment-state';
import type { AgentRunDetail } from '../domain/types.ts';
import {
	cancelAgentRun,
	enqueueAgentRun,
	loadAgents,
	loadAgentWorker,
	observeAgentRun,
} from './api.ts';
import { RunTimeline } from './RunTimeline.tsrx';
import { createAgentClientState } from './state.ts';

export interface AgentPlaygroundViewProps {
	readonly csrfToken: string;
}

function terminal(status: AgentRunDetail['status']): boolean {
	return ['succeeded', 'failed', 'cancelled'].includes(status);
}

export function AgentPlaygroundView(props: AgentPlaygroundViewProps) @{
	const client = useMemo(() => createAgentClientState(), []);
	const [agents] = useValue(client.state.agents);
	const [selectedAgentId, setSelectedAgentId] = useValue(
		client.state.selectedAgentId,
	);
	const [selectedRun, setSelectedRun] = useValue(client.state.selectedRun);
	const [input, setInput] = useValue(client.state.playgroundInput);
	const [submissionKey, setSubmissionKey] = useValue(
		client.state.playgroundKey,
	);
	const [worker, setWorker] = useValue(client.state.worker);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const activeAgents = agents.filter((agent) => agent.status === 'active');

	const refreshWorker = () => loadAgentWorker().then(setWorker).catch(
		() => setWorker(null),
	);

	useEffect(() => {
		setStatus('loading');
		void loadAgents().then((result) => {
			client.store.act((transaction) => {
				transaction.set(client.state.agents, result.agents);
				if (!selectedAgentId) {
					transaction.set(
						client.state.selectedAgentId,
						result.agents.find((agent) => agent.status === 'active')?.id ?? '',
					);
				}
			}, 'agents/playground-loaded');
		}).catch(
			(loadError) => setError(
				loadError instanceof Error
					? loadError.message
					: 'Could not load agents.',
			),
		).finally(() => setStatus('idle'));
		void refreshWorker();
		const timer = setInterval(() => void refreshWorker(), 15_000);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		if (!selectedRun || terminal(selectedRun.status)) return;
		return observeAgentRun(selectedRun.id, setSelectedRun, selectedRun.events);
	}, [selectedRun?.id, selectedRun?.status]);

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		setStatus('submitting');
		setError('');
		/* One key per submission. A failed request keeps it so the retry maps
   to the same run; editing the input starts a new submission. */
		const key = submissionKey || crypto.randomUUID();
		setSubmissionKey(key);
		try {
			const queued = await enqueueAgentRun(
				{
					agentId: selectedAgentId,
					input,
					toolGrants: agents.find(
						(agent) => agent.id === selectedAgentId,
					)?.allowedTools ??
						[],
				},
				props.csrfToken,
				key,
			);
			setSubmissionKey('');
			setSelectedRun({ ...queued, events: [] });
			void refreshWorker();
		} catch (runError) {
			setError(
				runError instanceof Error
					? runError.message
					: 'Could not queue the run.',
			);
		} finally {
			setStatus('idle');
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

	<div class="ui-view">
		<PageHeader
			eyebrow="Isolated test surface"
			title="Agent playground"
			description="Queue real harness runs while keeping execution detached from this browser session."
		/>
		<div class="ui-two-col ui-two-col--wide-aside">
			<section class="ui-card">
				<div class="ui-card__head">
					<span class="ui-card__title">
						New playground run
						<small>Returns after the durable enqueue commit</small>
					</span>
					<span
						class={[
							'playground-live',
							worker?.online !== true && 'playground-live--offline',
						]}
						title={worker
							? worker.inFlight + ' of ' + worker.concurrency + ' slots busy'
							: 'Worker status unavailable'}
					>
						<i
							class={['ui-dot', worker?.online !== true && 'ui-dot--muted']}
							aria-hidden="true"
						></i>
						{worker === null
							? 'worker status unknown'
							: worker.online
								? 'worker online · ' + worker.inFlight + ' running'
								: 'worker offline'}
					</span>
				</div>
				<form class="ui-form" onSubmit={submit}>
					<FormField label="Active agent">
						<select
							class="ui-select"
							value={selectedAgentId}
							onInput={(event) => {
								setSelectedAgentId(event.currentTarget.value);
								setSubmissionKey('');
							}}
							disabled={activeAgents.length === 0}
						>
							@if (activeAgents.length === 0) {
								<option value="">Activate an agent first</option>
							}
							@for (const agent of activeAgents; key agent.id) {
								<option value={agent.id}>
									{agent.name + ' · r' + agent.revision}
								</option>
							}
						</select>
					</FormField>
					<FormField label="Test input" required>
						<textarea
							class="ui-textarea"
							rows={10}
							value={input}
							onInput={(event) => {
								setInput(event.currentTarget.value);
								setSubmissionKey('');
							}}
							placeholder="Describe the outcome and include only the data needed for this run."
							maxlength={100_000}
							required
						></textarea>
					</FormField>
					@if (error) {
						<Alert>{error}</Alert>
					}
					<div class="ui-form__foot">
						<small>
							You can close this page after queuing. Progress and output remain
							in Agent runs.
						</small>
						<div class="ui-form__actions">
							<Button
								variant="primary"
								type="submit"
								disabled={status === 'submitting' || !selectedAgentId ||
									!input.trim()}
							>
								{status === 'submitting' ? 'Queuing…' : 'Queue run'}
							</Button>
						</div>
					</div>
				</form>
			</section>
			@if (selectedRun) {
				<RunTimeline
					run={selectedRun}
					onCancel={() => void cancel()}
					cancelling={status === 'submitting'}
				/>
			} @else {
				<aside class="ui-card">
					<EmptyState icon="flask" title="Ready for a durable run">
						The local simulation provider never calls a model or the network.
						Add a provider connection under Providers when credentials are
						ready.
					</EmptyState>
				</aside>
			}
		</div>
	</div>
}
