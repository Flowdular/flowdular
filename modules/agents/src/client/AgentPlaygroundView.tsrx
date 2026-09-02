import { useEffect, useMemo } from 'octane';
import { t } from '@coreloom/client';
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
					: t('agents.definitions.error.load'),
			),
		).finally(() => setStatus('idle'));
		void refreshWorker();
		const timer = setInterval(() => void refreshWorker(), 15_000);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		if (!selectedRun || terminal(selectedRun.status)) return;
		return observeAgentRun(
			selectedRun.id,
			setSelectedRun,
			selectedRun.timeline,
		);
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
			setSelectedRun({ ...queued, timeline: [] });
			void refreshWorker();
		} catch (runError) {
			setError(
				runError instanceof Error
					? runError.message
					: t('agents.playground.error.queue'),
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
					: t('agents.runs.error.cancel'),
			);
		} finally {
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('agents.playground.eyebrow')}
			title={t('agents.playground.title')}
			description={t('agents.playground.description')}
		/>
		<div class="ui-two-col ui-two-col--wide-aside">
			<section class="ui-card">
				<div class="ui-card__head">
					<span class="ui-card__title">
						{t('agents.playground.form.title')}
						<small>{t('agents.playground.form.subtitle')}</small>
					</span>
					<span
						class={[
							'playground-live',
							worker?.online !== true && 'playground-live--offline',
						]}
						title={worker
							? t('agents.playground.worker.slots', {
									inFlight: worker.inFlight,
									concurrency: worker.concurrency,
								})
							: t('agents.playground.worker.unavailable')}
					>
						<i
							class={['ui-dot', worker?.online !== true && 'ui-dot--muted']}
							aria-hidden="true"
						></i>
						{worker === null
							? t('agents.playground.worker.unknown')
							: worker.online
								? t('agents.playground.worker.online', {
										inFlight: worker.inFlight,
									})
								: t('agents.playground.worker.offline')}
					</span>
				</div>
				<form class="ui-form" onSubmit={submit}>
					<FormField label={t('agents.playground.form.agent')}>
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
								<option value="">{t(
									'agents.playground.form.activateFirst',
								)}</option>
							}
							@for (const agent of activeAgents; key agent.id) {
								<option value={agent.id}>
									{agent.name + ' · r' + agent.revision}
								</option>
							}
						</select>
					</FormField>
					<FormField label={t('agents.playground.form.input')} required>
						<textarea
							class="ui-textarea"
							rows={10}
							value={input}
							onInput={(event) => {
								setInput(event.currentTarget.value);
								setSubmissionKey('');
							}}
							placeholder={t('agents.playground.form.inputPlaceholder')}
							maxlength={100_000}
							required
						></textarea>
					</FormField>
					@if (error) {
						<Alert>{error}</Alert>
					}
					<div class="ui-form__foot">
						<small>{t('agents.playground.form.note')}</small>
						<div class="ui-form__actions">
							<Button
								variant="primary"
								type="submit"
								disabled={status === 'submitting' || !selectedAgentId ||
									!input.trim()}
							>
								{status === 'submitting'
									? t('agents.playground.form.queuing')
									: t('agents.playground.form.queue')}
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
					<EmptyState
						icon="flask"
						title={t('agents.playground.empty.title')}
					>{t('agents.playground.empty.hint')}</EmptyState>
				</aside>
			}
		</div>
	</div>
}
