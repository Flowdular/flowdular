import { useEffect } from 'octane';
import { Icon } from '@flowdular/ui';
import { activeLocale, applicationPath, t } from '@flowdular/client';
import { useValue } from 'segment-state';
import { NOTIFICATIONS_VIEWS, workspaceViewHref } from './navigation.ts';
import {
	clearUnreadCount,
	refreshUnreadCount,
	unreadCount,
} from './unread-count.ts';

/* The shell keeps the topbar mounted across views and publishes no navigation
   event, so the badge follows the signals it can actually observe: the inbox
   screen reports what it changed through the shared count, the browser reports
   a back or forward move and a tab coming back into view, and a slow interval
   covers a workspace left open on another screen. */
const REFRESH_INTERVAL_MS = 60_000;

export function UnreadCountWidget() @{
	const [unread] = useValue(unreadCount);

	useEffect(() => {
		/* The topbar remounts on a workspace switch; the previous workspace's
   count must not survive it. */
		clearUnreadCount();
		void refreshUnreadCount();
		const onNavigate = () => void refreshUnreadCount();
		const onVisibility = () => {
			if (document.visibilityState === 'visible') void refreshUnreadCount();
		};
		window.addEventListener('popstate', onNavigate);
		document.addEventListener('visibilitychange', onVisibility);
		const timer = setInterval(
			() => void refreshUnreadCount(),
			REFRESH_INTERVAL_MS,
		);
		return () => {
			window.removeEventListener('popstate', onNavigate);
			document.removeEventListener('visibilitychange', onVisibility);
			clearInterval(timer);
		};
	}, []);

	/* The address is read once per topbar mount, which is what the workspace
   slug in it lasts for. The shell turns a same-origin link to a view it can
   reach into an in-app move, so the badge never reloads the workspace. */
	const inboxHref = workspaceViewHref(
		NOTIFICATIONS_VIEWS.inbox,
		typeof window === 'undefined' ? '' : window.location.pathname,
		applicationPath(),
	);

	@if (unread > 0) {
		<a
			class="notifications-unread"
			href={inboxHref}
			aria-label={t('notifications.widget.label', { count: unread })}
			title={t('notifications.widget.label', { count: unread })}
		>
			<Icon name="activity" size={16} />
			<span
				class="notifications-unread__count num"
			>{new Intl.NumberFormat(activeLocale()).format(unread)}</span>
		</a>
	}
}
