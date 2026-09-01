import { useEffect, useMemo } from 'octane';
import { Alert, Button, EmptyState, Icon, Tag } from '@coreloom/ui';
import { cell, createStore, useValue } from 'segment-state';
import {
	loadOwnSessions,
	revokeOwnSession,
	type OwnSession,
} from './sessions-api.ts';

export interface SessionsCardProps {
	readonly csrfToken: string;
}

function stamp(value: number): string {
	return new Date(value).toISOString().slice(0, 16).replace('T', ' ');
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
					: 'Could not load your sessions.',
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
					: 'Could not end the session.',
			);
			setStatus('idle');
		}
	};

	<section class="ui-card">
		<div class="ui-card__head">
			<span class="ui-card__title">
				Sessions
				<small>{sessions.length + ' signed in'}</small>
			</span>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				Refresh
			</Button>
		</div>
		@if (error) {
			<Alert>{error}</Alert>
		}
		@if (status === 'loading' && sessions.length === 0) {
			<p class="ui-table__empty">Loading your sessions…</p>
		} @else if (sessions.length === 0) {
			<EmptyState icon="user" title="No active sessions">
				Signing in again creates a new session.
			</EmptyState>
		} @else {
			<div class="ui-table-wrap">
				<table class="ui-table" aria-label="Your sessions">
					<thead>
						<tr>
							<th>Workspace</th>
							<th>Last seen</th>
							<th>Expires</th>
							<th class="ui-table__actions"></th>
						</tr>
					</thead>
					<tbody>
						@for (const session of sessions; key session.id) {
							<tr>
								<td>
									<span class="ui-table__state">
										<span>{session.tenantName}</span>
										@if (session.current) {
											<Tag tone="success" dot>This device</Tag>
										}
									</span>
								</td>
								<td class="ui-mono">{stamp(session.lastSeenAt)}</td>
								<td class="ui-mono">{stamp(session.expiresAt)}</td>
								<td class="ui-table__actions">
									@if (!session.current) {
										<Button
											size="sm"
											variant="danger"
											disabled={status === 'submitting'}
											onClick={() => void revoke(session.id)}
										>
											Revoke
										</Button>
									}
								</td>
							</tr>
						}
					</tbody>
				</table>
			</div>
		}
		<p class="ui-note">
			<Icon name="shield" size={14} />
			<span>
				{others.length === 0
					? 'Only this device is signed in. Changing your password also ends every other session.'
					: others.length +
						' other session(s) can use your account. Revoke the ones you do not recognise.'}
			</span>
		</p>
	</section>
}
