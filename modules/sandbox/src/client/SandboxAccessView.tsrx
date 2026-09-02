import { useEffect, useMemo } from 'octane';
import { Alert, Button, Drawer, Icon, Kpi, PageHeader } from '@coreloom/ui';
import { t } from '@coreloom/client';
import { useValue } from 'segment-state';
import {
	grantSandboxAccess,
	loadSandboxAccess,
	loadSandboxSessions,
	revokeSandboxAccess,
	type GrantSandboxAccessRequest,
} from './api.ts';
import { SandboxGrantForm } from './SandboxGrantForm.tsrx';
import { SandboxGrantList } from './SandboxGrantList.tsrx';
import { SandboxSessionList } from './SandboxSessionList.tsrx';
import { createSandboxClientState } from './state.ts';
import { grantState } from './presentation.ts';

export interface SandboxAccessViewProps {
	readonly csrfToken: string;
	readonly canReadSessions: boolean;
}

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export function SandboxAccessView(props: SandboxAccessViewProps) @{
	const sandbox = useMemo(() => createSandboxClientState(), []);
	const [grants] = useValue(sandbox.state.grants);
	const [candidates] = useValue(sandbox.state.candidates);
	const [sessions] = useValue(sandbox.state.sessions);
	const [sandboxUrl] = useValue(sandbox.state.sandboxUrl);
	const [selectedAccountId, setSelectedAccountId] = useValue(
		sandbox.state.selectedAccountId,
	);
	const [status, setStatus] = useValue(sandbox.state.status);
	const [error, setError] = useValue(sandbox.state.error);
	const [formOpen, setFormOpen] = useValue(sandbox.state.formOpen);
	const activeGrants = grants.filter(
		(grant) => grantState(grant, Date.now()) === 'active',
	);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const snapshot = await loadSandboxAccess();
			const records = props.canReadSessions ? await loadSandboxSessions() : [];
			sandbox.store.act((transaction) => {
				transaction.set(sandbox.state.grants, snapshot.grants);
				transaction.set(sandbox.state.candidates, snapshot.candidates);
				transaction.set(sandbox.state.sandboxUrl, snapshot.sandbox.url);
				transaction.set(sandbox.state.sessions, records);
			}, 'sandbox/loaded');
		} catch (loadError) {
			setError(message(loadError, t('sandbox.error.load')));
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const submit = async (input: GrantSandboxAccessRequest) => {
		setStatus('submitting');
		setError('');
		try {
			await grantSandboxAccess(input, props.csrfToken);
			setSelectedAccountId('');
			setFormOpen(false);
			await refresh();
		} catch (grantError) {
			setError(message(grantError, t('sandbox.error.grant')));
			setStatus('idle');
		}
	};

	const revoke = async (accountId: string) => {
		setStatus('submitting');
		setError('');
		try {
			await revokeSandboxAccess(accountId, props.csrfToken);
			await refresh();
		} catch (revokeError) {
			setError(message(revokeError, t('sandbox.error.revoke')));
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('sandbox.page.eyebrow')}
			title={t('sandbox.access.title')}
			description={t('sandbox.access.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('sandbox.action.refresh')}
			</Button>
			<Button
				size="sm"
				onClick={() => window.open(sandboxUrl, '_blank', 'noopener')}
				disabled={!sandboxUrl}
			>
				<Icon name="external" size={14} />
				{t('sandbox.action.open')}
			</Button>
			<Button size="sm" variant="primary" onClick={() => setFormOpen(true)}>
				<Icon name="plus" size={14} />
				{t('sandbox.access.grant')}
			</Button>
		</PageHeader>
		<div class="ui-kpi-grid">
			<Kpi
				label={t('sandbox.kpi.activeAccess')}
				value={status === 'loading' ? '…' : String(activeGrants.length)}
				note={t('sandbox.kpi.activeAccessNote')}
			/>
			<Kpi
				label={t('sandbox.sessions.title')}
				value={props.canReadSessions
					? String(sessions.length)
					: t('sandbox.value.na')}
				note={t('sandbox.kpi.sessionsNote')}
			/>
			<Kpi
				label={t('sandbox.kpi.address')}
				value={sandboxUrl
					? t('sandbox.kpi.configured')
					: t('sandbox.kpi.unset')}
				note={<span class="ui-mono">
					{sandboxUrl || t('sandbox.kpi.startHint')}
				</span>}
			/>
		</div>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<section class="ui-card">
			<div class="ui-card__head">
				<span class="ui-card__title">
					{t('sandbox.access.listTitle')}
					<small>{t('sandbox.access.count', {
						active: activeGrants.length,
						total: grants.length,
					})}</small>
				</span>
			</div>
			<SandboxGrantList
				grants={grants}
				busy={status === 'submitting'}
				onRevoke={(accountId) => void revoke(accountId)}
			/>
			<p class="ui-note">
				<Icon name="shield" size={14} />
				<span>{t('sandbox.access.note')}</span>
			</p>
		</section>
		@if (props.canReadSessions) {
			<section class="ui-card">
				<div class="ui-card__head">
					<span class="ui-card__title">
						{t('sandbox.sessions.title')}
						<small>{t('sandbox.sessions.count', {
							count: sessions.length,
						})}</small>
					</span>
				</div>
				<SandboxSessionList sessions={sessions} />
			</section>
		}
		<Drawer
			open={formOpen}
			title={t('sandbox.drawer.title')}
			subtitle={t('sandbox.drawer.subtitle')}
			onClose={() => setFormOpen(false)}
		>
			<SandboxGrantForm
				candidates={candidates}
				selectedAccountId={selectedAccountId}
				busy={status === 'submitting'}
				error=""
				onSelect={setSelectedAccountId}
				onCancel={() => setFormOpen(false)}
				onSubmit={(input) => void submit(input)}
			/>
		</Drawer>
	</div>
}
