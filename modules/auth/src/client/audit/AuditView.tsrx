import { useEffect, useMemo } from 'octane';
import { Alert, Button, EmptyState, Icon, PageHeader } from '@coreloom/ui';
import { cell, createStore, useValue } from 'segment-state';
import type { AuditEvent } from '../../domain/types.ts';
import { ApiError, loadAudit } from './api.ts';
import { AuditTable } from './AuditTable.tsrx';

type AuditStatus = 'loading' | 'idle' | 'denied' | 'error';

function createAuditState() {
	const store = createStore({
		events: cell<readonly AuditEvent[]>([]),
		actions: cell<readonly string[]>([]),
		nextCursor: cell<string | null>(null),
		status: cell<AuditStatus>('loading'),
		error: '',
		action: '',
		actor: '',
	});
	return { store, state: store.state };
}

export function AuditView() @{
	const client = useMemo(() => createAuditState(), []);
	const [events] = useValue(client.state.events);
	const [actions] = useValue(client.state.actions);
	const [nextCursor] = useValue(client.state.nextCursor);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [action, setAction] = useValue(client.state.action);
	const [actor, setActor] = useValue(client.state.actor);

	const load = async (cursor: string | null) => {
		setStatus('loading');
		setError('');
		try {
			const page = await loadAudit({ action, actor: actor.trim(), cursor });
			client.store.act((transaction) => {
				transaction.set(
					client.state.events,
					cursor ? [...events, ...page.events] : page.events,
				);
				transaction.set(client.state.actions, page.actions);
				transaction.set(client.state.nextCursor, page.nextCursor);
				transaction.set(client.state.status, 'idle');
			}, 'audit/loaded');
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: 'Could not load the audit trail.',
			);
			setStatus(
				loadError instanceof ApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void load(null);
	}, []);

	<div class="ui-view">
		<PageHeader
			eyebrow="Administration"
			title="Audit"
			description="Sign-ins, credentials, membership, role, and settings changes in this workspace."
		>
			<Button size="sm" onClick={() => void load(null)}>
				<Icon name="refresh" size={14} />
				Refresh
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title="Access denied">
					Reading the audit trail needs the auth.audit.read scope.
				</EmptyState>
			</section>
		} @else {
			<>
				@if (status === 'error') {
					<Alert>{error}</Alert>
				}
				<section class="ui-card">
					<form
						class="ui-toolbar"
						onSubmit={(event: SubmitEvent) => {
							event.preventDefault();
							void load(null);
						}}
					>
						<select
							class="ui-select"
							aria-label="Action"
							value={action}
							onInput={(event) => setAction(
								(event.currentTarget as HTMLSelectElement).value,
							)}
						>
							<option value="">All actions</option>
							@for (const entry of actions; key entry) {
								<option value={entry}>{entry}</option>
							}
						</select>
						<input
							class="ui-input"
							aria-label="Actor"
							placeholder="Actor email or account id"
							value={actor}
							maxLength={254}
							onInput={(event) => setActor(
								(event.currentTarget as HTMLInputElement).value,
							)}
						/>
						<span class="ui-toolbar__spacer"></span>
						<Button type="submit" disabled={status === 'loading'}>
							<Icon name="filter" size={14} />
							Apply filters
						</Button>
					</form>
					@if (status === 'loading' && events.length === 0) {
						<p class="ui-table__empty">Loading audit events…</p>
					} @else if (events.length === 0) {
						<EmptyState icon="activity" title="No events yet">
							Sign-ins and administrative changes in this workspace appear here.
						</EmptyState>
					} @else {
						<AuditTable events={events} />
					}
					@if (nextCursor) {
						<div class="ui-toolbar">
							<span class="ui-toolbar__spacer"></span>
							<Button
								disabled={status === 'loading'}
								onClick={() => void load(nextCursor)}
							>
								Load older events
							</Button>
						</div>
					}
					<p class="ui-note">
						<Icon name="shield" size={14} />
						<span>
							The trail is append-only and never contains passwords, tokens, or
							request bodies.
						</span>
					</p>
				</section>
			</>
		}
	</div>
}
