import { useEffect } from 'octane';
import { Kpi } from '@flowdular/ui';
import { activeLocale, applicationPath, t } from '@flowdular/client';
import { useValue } from 'segment-state';
import { APPROVALS_VIEWS, workspaceViewHref } from './navigation.ts';
import {
	clearPendingCount,
	pendingCount,
	refreshPendingCount,
} from './pending-count.ts';

/* The dashboard stays mounted across views and publishes no navigation event,
   so the tile follows the signals it can observe: the Approvals screen reports
   what it decided through the shared count, the browser reports a back or
   forward move and a tab coming back into view. */
const REFRESH_INTERVAL_MS = 60_000;

export function PendingCountWidget() @{
	const [pending] = useValue(pendingCount);

	useEffect(() => {
		/* The dashboard remounts on a workspace switch; the previous workspace's
   count must not survive it. */
		clearPendingCount();
		void refreshPendingCount();
		const onNavigate = () => void refreshPendingCount();
		const onVisibility = () => {
			if (document.visibilityState === 'visible') void refreshPendingCount();
		};
		window.addEventListener('popstate', onNavigate);
		document.addEventListener('visibilitychange', onVisibility);
		const timer = setInterval(
			() => void refreshPendingCount(),
			REFRESH_INTERVAL_MS,
		);
		return () => {
			window.removeEventListener('popstate', onNavigate);
			document.removeEventListener('visibilitychange', onVisibility);
			clearInterval(timer);
		};
	}, []);

	@if (pending > 0) {
		<Kpi
			label={t('approvals.widget.label')}
			value={new Intl.NumberFormat(activeLocale()).format(pending)}
			note={t('approvals.widget.note')}
			href={workspaceViewHref(
				APPROVALS_VIEWS.inbox,
				typeof window === 'undefined' ? '' : window.location.pathname,
				applicationPath(),
			)}
			linkLabel={t('approvals.widget.link')}
		/>
	}
}
