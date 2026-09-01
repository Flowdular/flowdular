import { useEffect, useMemo } from 'octane';
import { Alert, Button, Drawer, Icon, Kpi, PageHeader } from '@coreloom/ui';
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
			setError(message(loadError, 'Could not load sandbox access.'));
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
			setError(message(grantError, 'Could not grant sandbox access.'));
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
			setError(message(revokeError, 'Could not revoke sandbox access.'));
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow="Development"
			title="Sandbox"
			description="Grant isolated module development access and follow the sessions it produces."
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				Refresh
			</Button>
			<Button
				size="sm"
				onClick={() => window.open(sandboxUrl, '_blank', 'noopener')}
				disabled={!sandboxUrl}
			>
				<Icon name="external" size={14} />
				Open sandbox
			</Button>
			<Button size="sm" variant="primary" onClick={() => setFormOpen(true)}>
				<Icon name="plus" size={14} />
				Grant access
			</Button>
		</PageHeader>
		<div class="ui-kpi-grid">
			<Kpi
				label="Active access"
				value={status === 'loading' ? '…' : String(activeGrants.length)}
				note="Accounts that can sign in to the sandbox right now."
			/>
			<Kpi
				label="Sessions"
				value={props.canReadSessions ? String(sessions.length) : 'n/a'}
				note="Module sessions registered by the sandbox application."
			/>
			<Kpi
				label="Sandbox address"
				value={sandboxUrl ? 'Configured' : 'Unset'}
				note={<span class="ui-mono">
					{sandboxUrl || 'Start it with npx @coreloom/sandbox.'}
				</span>}
			/>
		</div>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<section class="ui-card">
			<div class="ui-card__head">
				<span class="ui-card__title">
					Access
					<small>
						{activeGrants.length + ' active · ' + grants.length + ' granted'}
					</small>
				</span>
			</div>
			<SandboxGrantList
				grants={grants}
				busy={status === 'submitting'}
				onRevoke={(accountId) => void revoke(accountId)}
			/>
			<p class="ui-note">
				<Icon name="shield" size={14} />
				<span>
					A grant lets an account sign in to the sandbox with the listed
					capabilities. Workspace data stays behind the same permissions.
				</span>
			</p>
		</section>
		@if (props.canReadSessions) {
			<section class="ui-card">
				<div class="ui-card__head">
					<span class="ui-card__title">
						Sessions
						<small>{sessions.length + ' records, latest first'}</small>
					</span>
				</div>
				<SandboxSessionList sessions={sessions} />
			</section>
		}
		<Drawer
			open={formOpen}
			title="Grant sandbox access"
			subtitle="Owner-only, auditable, revocable"
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
