import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	Drawer,
	Icon,
	PageHeader,
	SearchField,
} from '@coreloom/ui';
import { useValue } from 'segment-state';
import {
	createApiToken,
	loadApiTokens,
	revokeApiToken,
	type CreateApiTokenRequest,
} from './api.ts';
import { ApiTokenForm } from './ApiTokenForm.tsrx';
import { ApiTokenList } from './ApiTokenList.tsrx';
import { ApiTokenSecret } from './ApiTokenSecret.tsrx';
import { createApiTokenClientState, tokenState } from './state.ts';
import '../auth.css';

export interface ApiTokensViewProps {
	readonly csrfToken: string;
}

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export function ApiTokensView(props: ApiTokensViewProps) @{
	const tokens = useMemo(() => createApiTokenClientState(), []);
	const [records] = useValue(tokens.state.tokens);
	const [availableScopes] = useValue(tokens.state.availableScopes);
	const [issuedToken, setIssuedToken] = useValue(tokens.state.issuedToken);
	const [issuedLabel, setIssuedLabel] = useValue(tokens.state.issuedLabel);
	const [status, setStatus] = useValue(tokens.state.status);
	const [error, setError] = useValue(tokens.state.error);
	const [query, setQuery] = useValue(tokens.state.query);
	const [formOpen, setFormOpen] = useValue(tokens.state.formOpen);
	const [formSession, setFormSession] = useValue(tokens.state.formSession);
	const active = records.filter(
		(record) => tokenState(record, Date.now()) === 'active',
	);
	const term = query.trim().toLocaleLowerCase('en-US');
	const visible =
		term === ''
			? records
			: records.filter(
					(record) =>
						record.label.toLocaleLowerCase('en-US').includes(term) ||
							record.scopes.some((scope) => scope.includes(term)),
				);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const snapshot = await loadApiTokens();
			tokens.store.act((transaction) => {
				transaction.set(tokens.state.tokens, snapshot.tokens);
				transaction.set(
					tokens.state.availableScopes,
					[...snapshot.availableScopes].sort(),
				);
			}, 'auth/tokens-loaded');
		} catch (loadError) {
			setError(message(loadError, 'Could not load API tokens.'));
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const openForm = () => {
		setIssuedToken('');
		setFormSession((current) => current + 1);
		setFormOpen(true);
	};

	const closeForm = () => {
		setFormOpen(false);
		setIssuedToken('');
	};

	const submit = async (input: CreateApiTokenRequest) => {
		setStatus('submitting');
		setError('');
		try {
			const issued = await createApiToken(input, props.csrfToken);
			setIssuedToken(issued.token);
			setIssuedLabel(issued.record.label);
			await refresh();
		} catch (createError) {
			setError(message(createError, 'Could not create the API token.'));
			setStatus('idle');
		}
	};

	const revoke = async (id: string) => {
		setStatus('submitting');
		setError('');
		try {
			await revokeApiToken(id, props.csrfToken);
			await refresh();
		} catch (revokeError) {
			setError(message(revokeError, 'Could not revoke the API token.'));
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow="Administration"
			title="API tokens"
			description="Machine credentials for clients that hold no browser session, such as a sandbox connected to this deployment."
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				Refresh
			</Button>
			<Button
				size="sm"
				variant="primary"
				disabled={availableScopes.length === 0}
				onClick={openForm}
			>
				<Icon name="plus" size={14} />
				New token
			</Button>
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<section class="ui-card">
			<div class="ui-card__head">
				<span class="ui-card__title">
					Tokens
					<small>
						{active.length + ' active · ' + records.length + ' issued'}
					</small>
				</span>
				<SearchField
					value={query}
					placeholder="Filter by label or scope"
					label="Filter API tokens"
					onInput={setQuery}
				/>
			</div>
			<ApiTokenList
				tokens={visible}
				filtered={term !== ''}
				busy={status === 'submitting'}
				onRevoke={(id) => void revoke(id)}
			/>
			<p class="ui-note">
				<Icon name="shield" size={14} />
				<span>
					A token proves machine identity only. Session-guarded mutations reject
					it regardless of the scopes granted here.
				</span>
			</p>
		</section>
		<Drawer
			open={formOpen}
			title={issuedToken ? 'Token created' : 'New API token'}
			subtitle={issuedToken
				? 'Shown once'
				: 'Machine credential for this workspace'}
			width="lg"
			onClose={closeForm}
		>
			@if (issuedToken) {
				<ApiTokenSecret
					label={issuedLabel}
					token={issuedToken}
					onDone={closeForm}
				/>
			} @else {
				<ApiTokenForm
					key={'token-form-' + formSession}
					availableScopes={availableScopes}
					busy={status === 'submitting'}
					onCancel={closeForm}
					onSubmit={(input) => void submit(input)}
				/>
			}
		</Drawer>
	</div>
}
