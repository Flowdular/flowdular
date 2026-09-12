import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	ConfirmDialog,
	DateField,
	Drawer,
	EmptyState,
	Filters,
	FormField,
	Icon,
	PageHeader,
	SearchField,
	Select,
	TableCard,
	Tag,
	ToastHost,
	toasts,
	type TableAction,
	type TableColumn,
} from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import { useValue } from 'segment-state';
import { SCIM_TOKEN_STATUSES, type ScimToken } from '../domain/types.ts';
import {
	createScimToken,
	directoryErrorMessage,
	DirectoryApiError,
	loadScimTokens,
	revokeScimToken,
	rotateScimToken,
} from './api.ts';
import {
	expiryFieldValue,
	expiryToTimestamp,
	tableEmpty,
	timestampLabel,
	tokenDisplayStatus,
	tokenStatusLabel,
	tokenStatusTone,
} from './presentation.ts';
import { createScimTokensClientState } from './state.ts';

export interface ScimTokensViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

/** The server refuses an expiry that has passed or is more than a year out. */
const MAX_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1_000;

function columns(): readonly TableColumn<ScimToken>[] {
	return [
		{
			key: 'label',
			header: t('directory.tokens.column.label'),
			width: '30%',
			value: (token) => token.label,
			cell: (token) => <b>{token.label}</b>,
		},
		{
			key: 'status',
			header: t('directory.tokens.column.status'),
			width: '14%',
			value: (token) => tokenDisplayStatus(token),
			cell: (token) =>
				<Tag
					tone={tokenStatusTone(tokenDisplayStatus(token))}
					dot
				>{tokenStatusLabel(tokenDisplayStatus(token))}</Tag>,
		},
		{
			key: 'tokenFingerprint',
			header: t('directory.tokens.column.fingerprint'),
			width: '24%',
			value: (token) => token.tokenFingerprint,
			cell: (token) => <span class="ui-mono">{token.tokenFingerprint}</span>,
		},
		{
			key: 'lastUsedAt',
			header: t('directory.tokens.column.lastUsed'),
			width: '16%',
			value: (token) => token.lastUsedAt ?? 0,
			cell: (token) => timestampLabel(token.lastUsedAt),
		},
		{
			key: 'expiresAt',
			header: t('directory.tokens.column.expires'),
			width: '16%',
			value: (token) => token.expiresAt ?? 0,
			cell: (token) => token.expiresAt === null
				? t('directory.tokens.neverExpires')
				: timestampLabel(token.expiresAt),
		},
	];
}

export function ScimTokensView(props: ScimTokensViewProps) @{
	const client = useMemo(() => createScimTokensClientState(), []);
	const [tokens] = useValue(client.state.tokens);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [statusFilter, setStatusFilter] = useValue(client.state.statusFilter);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [editorOpen] = useValue(client.state.editorOpen);
	const [selectedId, setSelectedId] = useValue(client.state.selectedId);
	const [expiresAt, setExpiresAt] = useValue(client.state.expiresAt);
	const [revealed] = useValue(client.state.revealedToken);
	const [confirm, setConfirm] = useValue(client.state.confirm);
	const selected = tokens.find((token) => token.id === selectedId) ?? null;
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const visible = tokens.filter(
		(token) =>
			(statusFilter === '' || token.status === statusFilter) &&
				(term === '' || token.label.toLocaleLowerCase(locale).includes(term)),
	);
	const filtered = term !== '' || statusFilter !== '';

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const loaded = await loadScimTokens();
			client.store.act((transaction) => {
				transaction.set(client.state.tokens, loaded);
				transaction.set(client.state.status, 'idle');
			}, 'directory/tokens-loaded');
		} catch (loadError) {
			setError(directoryErrorMessage(loadError, 'directory.tokens.error.load'));
			setStatus(
				loadError instanceof DirectoryApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const openNew = () => {
		client.store.act((transaction) => {
			transaction.set(client.state.selectedId, '');
			transaction.set(client.state.revealedToken, '');
			transaction.set(client.state.expiresAt, '');
			transaction.set(client.state.error, '');
			transaction.set(client.state.editorOpen, true);
		}, 'directory/token-new');
	};

	/* Closing the drawer is what drops the token value: it is never returned
   again, and nothing else in the screen holds it. */
	const closeEditor = () => {
		client.store.act((transaction) => {
			transaction.set(client.state.editorOpen, false);
			transaction.set(client.state.revealedToken, '');
			transaction.set(client.state.confirm, null);
			transaction.set(client.state.error, '');
		}, 'directory/token-close');
	};

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const label = String(form.get('label') ?? '').trim();
		setStatus('submitting');
		setError('');
		try {
			const issued = await createScimToken(
				{ label, expiresAt: expiryToTimestamp(expiresAt) },
				props.csrfToken,
			);
			await refresh();
			client.store.act((transaction) => {
				transaction.set(client.state.selectedId, issued.record.id);
				transaction.set(client.state.revealedToken, issued.token);
				transaction.set(client.state.status, 'idle');
			}, 'directory/token-created');
			toasts.success(t('directory.tokens.notice.created'));
		} catch (submitError) {
			setError(
				directoryErrorMessage(submitError, 'directory.tokens.error.save'),
			);
			setStatus('idle');
		}
	};

	const rotate = async () => {
		if (!selected) return;
		const id = selected.id;
		setConfirm(null);
		setStatus('submitting');
		setError('');
		try {
			const issued = await rotateScimToken(
				id,
				selected.expiresAt,
				props.csrfToken,
			);
			await refresh();
			client.store.act((transaction) => {
				transaction.set(client.state.selectedId, id);
				transaction.set(client.state.revealedToken, issued.token);
				transaction.set(client.state.editorOpen, true);
				transaction.set(client.state.status, 'idle');
			}, 'directory/token-rotated');
			toasts.success(t('directory.tokens.notice.rotated'));
		} catch (rotateError) {
			setError(
				directoryErrorMessage(rotateError, 'directory.tokens.error.action'),
			);
			setStatus('idle');
		}
	};

	const revoke = async () => {
		if (!selected) return;
		const id = selected.id;
		setConfirm(null);
		setStatus('submitting');
		setError('');
		try {
			await revokeScimToken(id, props.csrfToken);
			await refresh();
			setSelectedId('');
			toasts.success(t('directory.tokens.notice.revoked'));
		} catch (revokeError) {
			setError(
				directoryErrorMessage(revokeError, 'directory.tokens.error.action'),
			);
			setStatus('idle');
		}
	};

	/* Rotation carries the stored expiry forward and the server refuses one
   that has already passed, so an expired token is revoked, not rotated. The
   label carries that reason: a disabled row action has nowhere else to put it. */
	const rotatable = (token: ScimToken): boolean =>
		tokenDisplayStatus(token) === 'active';

	const rowActions = (token: ScimToken): readonly TableAction[] =>
		props.canManage && token.status === 'active'
			? [
					{
						id: 'rotate',
						label: rotatable(token)
							? t('directory.tokens.action.rotate')
							: t('directory.tokens.action.rotateExpired'),
						icon: 'refresh',
						disabled: !rotatable(token),
						onSelect: () => {
							setSelectedId(token.id);
							setConfirm('rotate');
						},
					},
					{
						id: 'revoke',
						label: t('directory.tokens.action.revoke'),
						icon: 'x',
						tone: 'danger',
						onSelect: () => {
							setSelectedId(token.id);
							setConfirm('revoke');
						},
					},
				]
			: [];

	<div class="ui-view">
		<PageHeader
			eyebrow={t('directory.common.administration')}
			title={t('directory.tokens.title')}
			description={t('directory.tokens.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh()}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('directory.common.refreshing')
					: t('directory.common.refresh')}
			</Button>
			@if (props.canManage) {
				<Button
					size="sm"
					variant="primary"
					disabled={status === 'denied'}
					onClick={openNew}
				>
					<Icon name="plus" size={14} />
					{t('directory.tokens.action.new')}
				</Button>
			}
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('directory.common.accessDenied')}>{t(
					'directory.tokens.denied',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (error && !editorOpen) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('directory.tokens.table.title')}
					count={t('directory.tokens.table.count', { count: visible.length })}
					search={<SearchField
						value={query}
						placeholder={t('directory.tokens.search.placeholder')}
						label={t('directory.tokens.search.label')}
						onInput={setQuery}
					/>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={statusFilter === '' ? 0 : 1}
						label={t('directory.common.filters')}
					>
						<Select
							id="directory-tokens-status"
							label={t('directory.tokens.filter.status')}
							value={statusFilter}
							options={[
								{ value: '', label: t('directory.tokens.filter.allStatuses') },
								...SCIM_TOKEN_STATUSES.map(
									(entry) => ({
										value: entry,
										label: tokenStatusLabel(entry),
									}),
								),
							]}
							onChange={(value) => setStatusFilter(
								value as ScimToken['status'] | '',
							)}
						/>
					</Filters>}
					caption={t('directory.tokens.table.caption')}
					columns={columns()}
					rows={visible}
					rowKey={(token) => token.id}
					sorting
					status={status === 'loading' && tokens.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('directory.tokens.table.loading')}
					filtered={filtered}
					empty={tableEmpty(status, {
						icon: 'key',
						title: t('directory.tokens.empty.title'),
						hint: t('directory.tokens.empty.hint'),
					})}
					emptyFiltered={tableEmpty(status, {
						icon: 'search',
						title: t('directory.tokens.emptyFiltered.title'),
						hint: t('directory.tokens.emptyFiltered.hint'),
					})}
					selectedKey={selected?.id}
					actions={rowActions}
					actionsLabel={t('directory.common.actions')}
					actionsWidth="220px"
					noteIcon="shield"
					note={t('directory.tokens.note')}
				/>
			</>
		}
		<Drawer
			open={editorOpen}
			title={revealed
				? t('directory.tokens.drawer.issuedTitle')
				: t('directory.tokens.drawer.newTitle')}
			subtitle={revealed
				? t('directory.tokens.drawer.issuedSubtitle')
				: t('directory.tokens.drawer.newSubtitle')}
			onClose={closeEditor}
		>
			@if (revealed) {
				<div class="ui-drawer__body">
					<div class="ui-form">
						<Alert tone="warning">{t('directory.tokens.reveal.warning')}</Alert>
						<FormField
							label={t('directory.tokens.reveal.label')}
							help={t('directory.tokens.reveal.help')}
						>
							<input
								class="ui-input ui-mono"
								value={revealed}
								readOnly
								autoFocus
							/>
						</FormField>
						<div class="ui-form__actions">
							<Button variant="primary" onClick={closeEditor}>{t(
								'directory.tokens.reveal.done',
							)}</Button>
						</div>
					</div>
				</div>
			} @else {
				<form class="ui-drawer__form" onSubmit={(event) => void submit(event)}>
					<div class="ui-drawer__body">
						<div class="ui-form">
							<FormField
								label={t('directory.tokens.form.label')}
								help={t('directory.tokens.form.labelHelp')}
								required
							>
								<input
									class="ui-input"
									name="label"
									minlength={2}
									maxlength={120}
									autoFocus
									required
								/>
							</FormField>
							<DateField
								id="directory-token-expiry"
								kind="datetime"
								label={t('directory.tokens.form.expiry')}
								help={t('directory.tokens.form.expiryHelp')}
								locale={locale}
								value={expiresAt}
								min={expiryFieldValue(Date.now())}
								max={expiryFieldValue(Date.now() + MAX_TOKEN_LIFETIME_MS)}
								onChange={setExpiresAt}
							/>
							@if (error) {
								<Alert>{error}</Alert>
							}
						</div>
					</div>
					<div class="ui-drawer__foot">
						<small>{t('directory.tokens.form.note')}</small>
						<div class="ui-form__actions">
							<Button onClick={closeEditor}>{t(
								'directory.common.cancel',
							)}</Button>
							<Button
								variant="primary"
								type="submit"
								disabled={status === 'submitting'}
							>
								{status === 'submitting'
									? t('directory.common.saving')
									: t('directory.tokens.form.create')}
							</Button>
						</div>
					</div>
				</form>
			}
		</Drawer>
		<ConfirmDialog
			open={confirm === 'rotate'}
			title={t('directory.tokens.rotate.title')}
			confirmLabel={t('directory.tokens.action.rotate')}
			tone="primary"
			busy={status === 'submitting'}
			onConfirm={() => void rotate()}
			onCancel={() => setConfirm(null)}
		>{t('directory.tokens.rotate.description', {
			label: selected?.label ?? '',
		})}</ConfirmDialog>
		<ConfirmDialog
			open={confirm === 'revoke'}
			title={t('directory.tokens.revoke.title')}
			confirmLabel={t('directory.tokens.action.revoke')}
			busy={status === 'submitting'}
			onConfirm={() => void revoke()}
			onCancel={() => setConfirm(null)}
		>{t('directory.tokens.revoke.description', {
			label: selected?.label ?? '',
		})}</ConfirmDialog>
		<ToastHost
			label={t('directory.common.messages')}
			closeLabel={t('directory.common.close')}
		/>
	</div>
}
