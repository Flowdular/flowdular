import { useEffect, useMemo } from 'octane';
import { activeLocale, t } from '@flowdular/client';
import {
	Alert,
	Button,
	Drawer,
	Icon,
	PageHeader,
	SearchField,
	TableCard,
} from '@flowdular/ui';
import { useValue } from 'segment-state';
import {
	createApiToken,
	loadApiTokens,
	revokeApiToken,
	type CreateApiTokenRequest,
} from './api.ts';
import { ApiTokenForm } from './ApiTokenForm.tsrx';
import { ApiTokenSecret } from './ApiTokenSecret.tsrx';
import { apiTokenColumns } from './token-columns.tsrx';
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
	const now = Date.now();
	const active = records.filter(
		(record) => tokenState(record, now) === 'active',
	);
	const columns = apiTokenColumns(now);
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const visible =
		term === ''
			? records
			: records.filter(
					(record) =>
						record.label.toLocaleLowerCase(locale).includes(term) ||
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
			setError(message(loadError, t('auth.tokens.error.load')));
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
			setError(message(createError, t('auth.tokens.error.create')));
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
			setError(message(revokeError, t('auth.tokens.error.revoke')));
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('auth.common.administration')}
			title={t('auth.tokens.title')}
			description={t('auth.tokens.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('auth.common.refresh')}
			</Button>
			<Button
				size="sm"
				variant="primary"
				disabled={availableScopes.length === 0}
				onClick={openForm}
			>
				<Icon name="plus" size={14} />
				{t('auth.tokens.new')}
			</Button>
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<TableCard
			title={t('auth.tokens.table.title')}
			count={t('auth.tokens.table.count', {
				active: active.length,
				total: records.length,
			})}
			search={<SearchField
				value={query}
				placeholder={t('auth.tokens.search.placeholder')}
				label={t('auth.tokens.search.label')}
				onInput={setQuery}
			/>}
			caption={t('auth.tokens.table.caption')}
			columns={columns}
			rows={visible}
			rowKey={(token) => token.id}
			status={status === 'loading' && records.length === 0 ? 'loading' : 'idle'}
			loadingLabel={t('auth.tokens.loading')}
			filtered={term !== ''}
			empty={{
				icon: 'key',
				title: t('auth.tokens.empty.title'),
				hint: t('auth.tokens.empty.hint'),
			}}
			emptyFiltered={{
				icon: 'key',
				title: t('auth.tokens.empty.filteredTitle'),
				hint: t('auth.tokens.empty.filteredHint'),
			}}
			actionsLabel={t('auth.common.actions')}
			actions={(token) => token.revokedAt === null
				? [
						{
							id: 'revoke',
							label: t('auth.tokens.revoke'),
							icon: 'x',
							tone: 'danger',
							disabled: status === 'submitting',
							onSelect: () => void revoke(token.id),
						},
					]
				: []}
			noteIcon="shield"
			note={t('auth.tokens.note')}
		/>
		<Drawer
			open={formOpen}
			title={issuedToken
				? t('auth.tokens.drawer.createdTitle')
				: t('auth.tokens.drawer.newTitle')}
			subtitle={issuedToken
				? t('auth.tokens.drawer.once')
				: t('auth.tokens.drawer.subtitle')}
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
