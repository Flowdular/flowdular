import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	CellStack,
	CellTag,
	CellTime,
	Icon,
	TableCard,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { cell, createStore, useValue } from 'segment-state';
import {
	loadOwnSessions,
	revokeOwnSession,
	type OwnSession,
} from './sessions-api.ts';

export interface SessionsCardProps {
	readonly csrfToken: string;
}

function columns(): readonly TableColumn<OwnSession>[] {
	return [
		{
			key: 'workspace',
			header: t('profile.sessions.workspace'),
			width: 'auto',
			cell: (session) =>
				<CellStack
					primary={session.tenantName}
					secondary={session.current
						? <CellTag
								tone="success"
								dot
								label={t('profile.sessions.thisDevice')}
							/>
						: undefined}
				/>,
		},
		{
			key: 'lastSeen',
			header: t('profile.sessions.lastSeen'),
			width: '170px',
			cell: (session) => <CellTime value={session.lastSeenAt} />,
		},
		{
			key: 'expires',
			header: t('profile.sessions.expires'),
			width: '170px',
			priority: 2,
			cell: (session) => <CellTime value={session.expiresAt} />,
		},
	];
}

export function SessionsCard(props: SessionsCardProps) @{
	const client = useMemo(
		() => createStore({
			sessions: cell<readonly OwnSession[]>([]),
			status: cell<'loading' | 'idle' | 'submitting' | 'error'>('loading'),
			error: '',
		}),
		[],
	);
	const [sessions] = useValue(client.state.sessions);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const others = sessions.filter((session) => !session.current);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			client.act((transaction) => {
				transaction.set(client.state.status, 'loading');
			}, 'profile/sessions-loading');
			const loaded = await loadOwnSessions();
			client.act((transaction) => {
				transaction.set(client.state.sessions, loaded);
				transaction.set(client.state.status, 'idle');
			}, 'profile/sessions-loaded');
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('profile.sessions.errorLoad'),
			);
			setStatus('error');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const revoke = async (id: string) => {
		setStatus('submitting');
		setError('');
		try {
			await revokeOwnSession(id, props.csrfToken);
			client.act((transaction) => {
				transaction.set(
					client.state.sessions,
					sessions.filter((session) => session.id !== id),
				);
				transaction.set(client.state.status, 'idle');
			}, 'profile/session-revoked');
		} catch (revokeError) {
			setError(
				revokeError instanceof Error
					? revokeError.message
					: t('profile.sessions.errorRevoke'),
			);
			setStatus('idle');
		}
	};

	<TableCard
		title={t('profile.sessions.title')}
		count={t('profile.sessions.count', { count: sessions.length })}
		head={<Button size="sm" onClick={() => void refresh()}>
			<Icon name="refresh" size={14} />
			{t('profile.action.refresh')}
		</Button>}
		before={error ? <Alert>{error}</Alert> : null}
		caption={t('profile.sessions.caption')}
		columns={columns()}
		rows={sessions}
		rowKey={(session) => session.id}
		status={status === 'loading' && sessions.length === 0 ? 'loading' : 'idle'}
		loadingLabel={t('profile.sessions.loading')}
		empty={{
			icon: 'user',
			title: t('profile.sessions.emptyTitle'),
			hint: t('profile.sessions.emptyHint'),
		}}
		actionsLabel={t('profile.sessions.actions')}
		actions={(session) => session.current
			? []
			: [
					{
						id: 'revoke',
						label: t('profile.sessions.revoke'),
						icon: 'x',
						tone: 'danger',
						disabled: status === 'submitting',
						onSelect: () => void revoke(session.id),
					},
				]}
		noteIcon="shield"
		note={others.length === 0
			? t('profile.sessions.onlyThisDevice')
			: t('profile.sessions.otherDevices', { count: others.length })}
	/>
}
