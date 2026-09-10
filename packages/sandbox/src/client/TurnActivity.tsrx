import { useEffect, useState } from 'octane';
import { useTranslation } from './i18n.ts';

/* Mounted only while a turn runs. Age measures received updates, not provider
   health: a quiet process can still be generating or waiting on the network. */
export function TurnActivity(props: {
	readonly lastUpdateAt: number | undefined;
}) @{
	const { t } = useTranslation();
	const [startedAt] = useState(Date.now());
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const seconds = Math.max(
		0,
		Math.floor((now - (props.lastUpdateAt ?? startedAt)) / 1000),
	);
	<span class="chat__activity-age">{t(
		seconds >= 30
			? 'sandbox.chat.activity.quiet'
			: 'sandbox.chat.activity.updated',
		{ seconds },
	)}</span>
}
