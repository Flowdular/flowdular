import { useEffect, useMemo } from 'octane';
import { t } from '@flowdular/client';
import { Kpi } from '@flowdular/ui';
import { useValue } from 'segment-state';
import { loadAgentRuns } from './api.ts';
import { countLabel } from './presentation.ts';
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
		label={t('agents.widget.label')}
		value={status === 'loading' ? '…' : countLabel(active)}
		note={t('agents.widget.note')}
		href="/agent-runs"
		linkLabel={t('agents.widget.link')}
	/>
}
