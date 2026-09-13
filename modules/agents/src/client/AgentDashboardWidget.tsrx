import { useEffect, useMemo, useState } from 'octane';
import { t } from '@flowdular/client';
import { Kpi } from '@flowdular/ui';
import { useValue } from 'segment-state';
import { loadAllAgentRuns } from './api.ts';
import { countLabel } from './presentation.ts';
import { createAgentClientState } from './state.ts';

export function AgentDashboardWidget() @{
	const client = useMemo(() => createAgentClientState(), []);
	const [runs] = useValue(client.state.runs);
	const [status, setStatus] = useValue(client.state.status);
	const [complete, setComplete] = useState(true);
	/* The tile counts the work in flight, so it walks those two statuses to
   their end; past WHOLE_LIST_CAP of either the count reads as a floor. */
	useEffect(() => {
		setStatus('loading');
		void Promise.all([
			loadAllAgentRuns({ status: 'queued' }),
			loadAllAgentRuns({ status: 'running' }),
		]).then(([queued, running]) => {
			client.store.act(
				(transaction) => transaction.set(client.state.runs, [
					...queued.items,
					...running.items,
				]),
				'agents/widget-loaded',
			);
			setComplete(queued.complete && running.complete);
		}).catch(() => undefined).finally(() => setStatus('idle'));
	}, []);
	const active = countLabel(runs.length) + (complete ? '' : '+');
	<Kpi
		label={t('agents.widget.label')}
		value={status === 'loading' ? '…' : active}
		note={t('agents.widget.note')}
		href="/agent-runs"
		linkLabel={t('agents.widget.link')}
	/>
}
