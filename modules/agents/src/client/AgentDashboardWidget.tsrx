import { useEffect, useMemo } from 'octane';
import { Kpi } from '@coreloom/ui';
import { useValue } from 'segment-state';
import { loadAgentRuns } from './api.ts';
import { createAgentClientState } from './state.ts';

export function AgentDashboardWidget() @{
	const client = useMemo(() => createAgentClientState(), []);
	const [runs] = useValue(client.state.runs);
	const [status, setStatus] = useValue(client.state.status);
	useEffect(() => {
		setStatus('loading');
		void loadAgentRuns().then(
			(records) => client.store.act(
				(transaction) => transaction.set(client.state.runs, records),
				'agents/widget-loaded',
			),
		).catch(() => undefined).finally(() => setStatus('idle'));
	}, []);
	const active = runs.filter(
		(run) => ['queued', 'running'].includes(run.status),
	).length;
	<Kpi
		label="Agent operations"
		value={status === 'loading' ? '…' : String(active)}
		note="Queued and running tasks that continue outside the browser."
		href="/agent-runs"
		linkLabel="Open agent runs"
	/>
}
