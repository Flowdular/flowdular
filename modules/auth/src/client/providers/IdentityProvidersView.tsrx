import { useEffect, useMemo } from 'octane';
import { activeLocale, t } from '@flowdular/client';
import {
	Alert,
	Button,
	Drawer,
	EmptyState,
	FormField,
	Icon,
	PageHeader,
	SearchField,
	SettingRow,
	Tag,
	TableCard,
} from '@flowdular/ui';
import { useValue } from 'segment-state';
import type { IdentityProviderSummary } from '../../domain/types.ts';
import {
	createIdentityProvider,
	deleteIdentityProvider,
	loadIdentityProviders,
	rotateIdentityProviderSecret,
	setIdentityProviderStatus,
	updateIdentityProvider,
	type IdentityProviderRequest,
} from './api.ts';
import { IdentityProviderForm } from './IdentityProviderForm.tsrx';
import { identityProviderColumns } from './provider-columns.tsrx';
import {
	createIdentityProviderClientState,
	providerReadDenied,
} from './state.ts';
import '../auth.css';

export interface IdentityProvidersViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export function IdentityProvidersView(props: IdentityProvidersViewProps) @{
	const providers = useMemo(() => createIdentityProviderClientState(), []);
	const [records] = useValue(providers.state.providers);
	const [status, setStatus] = useValue(providers.state.status);
	const [error, setError] = useValue(providers.state.error);
	const [notice, setNotice] = useValue(providers.state.notice);
	const [query, setQuery] = useValue(providers.state.query);
	const [selectedId, setSelectedId] = useValue(providers.state.selectedId);
	const [creating, setCreating] = useValue(providers.state.creating);
	const [formSession, setFormSession] = useValue(providers.state.formSession);
	const [denied, setDenied] = useValue(providers.state.denied);
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const visible =
		term === ''
			? records
			: records.filter(
					(provider) =>
						provider.label.toLocaleLowerCase(locale).includes(term) ||
							provider.key.includes(term) ||
							provider.issuer.toLocaleLowerCase(locale).includes(term),
				);
	const selected = records.find((provider) => provider.id === selectedId);
	const editable = props.canManage && selected?.scope === 'tenant';

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const snapshot = await loadIdentityProviders();
			providers.store.act((transaction) => {
				transaction.set(providers.state.providers, snapshot);
				transaction.set(providers.state.denied, false);
			}, 'auth/providers-loaded');
		} catch (loadError) {
			setError(message(loadError, t('auth.providers.error.load')));
			setDenied(providerReadDenied(loadError));
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const open = (provider: IdentityProviderSummary | null) => {
		providers.store.act((transaction) => {
			transaction.set(providers.state.selectedId, provider?.id ?? '');
			transaction.set(providers.state.creating, provider === null);
			transaction.set(providers.state.error, '');
			transaction.set(providers.state.notice, '');
		}, 'auth/provider-open');
		setFormSession((current) => current + 1);
	};

	const close = () => {
		providers.store.act((transaction) => {
			transaction.set(providers.state.selectedId, '');
			transaction.set(providers.state.creating, false);
			transaction.set(providers.state.notice, '');
		}, 'auth/provider-close');
	};

	const run = async (
		action: () => Promise<void>,
		fallback: string,
	): Promise<void> => {
		setStatus('submitting');
		setError('');
		try {
			await action();
			await refresh();
		} catch (actionError) {
			setError(message(actionError, fallback));
			setStatus('idle');
		}
	};

	const submit = (input: IdentityProviderRequest) => void run(async () => {
		if (input.id) {
			await updateIdentityProvider(input, props.csrfToken);
		} else {
			await createIdentityProvider(input, props.csrfToken);
		}
		close();
	}, t('auth.providers.error.save'));

	const rotate = (event: SubmitEvent) => {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		const data = new FormData(form);
		const secret = data.get('clientSecret');
		if (!selected || typeof secret !== 'string' || secret.trim() === '') return;
		void run(async () => {
			await rotateIdentityProviderSecret(
				selected.id,
				secret.trim(),
				props.csrfToken,
			);
			form.reset();
			setNotice(t('auth.providers.secret.rotated'));
		}, t('auth.providers.error.rotate'));
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('auth.common.administration')}
			title={t('auth.providers.title')}
			description={t('auth.providers.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('auth.common.refresh')}
			</Button>
			@if (props.canManage) {
				<Button size="sm" variant="primary" onClick={() => open(null)}>
					<Icon name="plus" size={14} />
					{t('auth.providers.new')}
				</Button>
			}
		</PageHeader>
		@if (denied) {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('auth.common.accessDenied')}>{t(
					'auth.providers.denied',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (error) {
					<section class="ui-card">
						<Alert>{error}</Alert>
						<div class="ui-form__actions">
							<Button
								size="sm"
								disabled={status === 'loading'}
								onClick={() => void refresh()}
							>
								<Icon name="refresh" size={14} />
								{t('auth.common.retry')}
							</Button>
						</div>
					</section>
				}
				<TableCard
					title={t('auth.providers.table.title')}
					count={t('auth.providers.table.count', { total: records.length })}
					search={<SearchField
						value={query}
						placeholder={t('auth.providers.search.placeholder')}
						label={t('auth.providers.search.label')}
						onInput={setQuery}
					/>}
					caption={t('auth.providers.table.caption')}
					columns={identityProviderColumns()}
					rows={visible}
					rowKey={(provider) => provider.id}
					status={status === 'loading' && records.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('auth.providers.loading')}
					filtered={term !== ''}
					empty={{
						icon: 'key',
						title: t('auth.providers.empty.title'),
						hint: t('auth.providers.empty.hint'),
					}}
					emptyFiltered={{
						icon: 'key',
						title: t('auth.providers.empty.filteredTitle'),
						hint: t('auth.providers.empty.filteredHint'),
					}}
					actionsLabel={t('auth.common.actions')}
					actions={(provider) => [
						{
							id: 'open',
							label: t('auth.providers.open'),
							icon: 'settings',
							onSelect: () => open(provider),
						},
					]}
					noteIcon="shield"
					note={t('auth.providers.note')}
				/>
			</>
		}
		<Drawer
			open={creating || selected !== undefined}
			title={creating
				? t('auth.providers.drawer.newTitle')
				: selected?.label ?? ''}
			subtitle={creating
				? t('auth.providers.drawer.newSubtitle')
				: selected?.scope === 'platform'
					? t('auth.providers.scope.platformHint')
					: t('auth.providers.drawer.subtitle')}
			width="lg"
			onClose={close}
		>
			@if (creating) {
				<IdentityProviderForm
					key={'provider-create-' + formSession}
					busy={status === 'submitting'}
					onCancel={close}
					onSubmit={submit}
				/>
			} @else if (selected) {
				<div class="ui-drawer__body">
					<SettingRow
						label={t('auth.providers.column.status')}
						description={selected.scope === 'platform'
							? t('auth.providers.scope.platform')
							: t('auth.providers.scope.tenant')}
					>
						<Tag
							tone={selected.status === 'active' ? 'success' : 'neutral'}
							dot
						>{t('auth.providers.status.' + selected.status)}</Tag>
					</SettingRow>
					<SettingRow
						label={t('auth.providers.column.fingerprint')}
						description={t('auth.providers.note')}
					>
						<span class="ui-mono">
							{selected.secretFingerprint || t('auth.common.none')}
						</span>
					</SettingRow>
					<SettingRow label={t('auth.providers.column.issuer')}>
						<span class="ui-mono">{selected.issuer}</span>
					</SettingRow>
					<SettingRow label={t('auth.providers.form.clientId')}>
						<span class="ui-mono">{selected.clientId}</span>
					</SettingRow>
					<SettingRow label={t('auth.providers.form.jit')}>
						<span>
							{selected.jitEnabled
								? t('auth.providers.jit.detail', {
										domains: selected.allowedDomains.join(', '),
										role: selected.jitRole,
									})
								: t('auth.providers.jit.off')}
						</span>
					</SettingRow>
					@if (notice) {
						<Alert tone="info">{notice}</Alert>
					}
					@if (editable) {
						<>
							<IdentityProviderForm
								key={'provider-edit-' + selected.id + '-' + formSession}
								provider={selected}
								busy={status === 'submitting'}
								onCancel={close}
								onSubmit={submit}
							/>
							<form class="ui-form" onSubmit={rotate}>
								<FormField
									label={t('auth.providers.secret.rotate')}
									help={t('auth.providers.secret.rotateHelp')}
								>
									<input
										class="ui-input"
										name="clientSecret"
										type="password"
										autocomplete="off"
										maxlength={1024}
										required
									/>
								</FormField>
								<div class="ui-form__actions">
									<Button type="submit" disabled={status === 'submitting'}>{t(
										'auth.providers.secret.rotateAction',
									)}</Button>
								</div>
							</form>
							<div class="ui-form__actions">
								<Button
									disabled={status === 'submitting'}
									onClick={() => void run(
										() => setIdentityProviderStatus(
											selected.id,
											selected.status === 'active' ? 'disabled' : 'active',
											props.csrfToken,
										).then(() => undefined),
										t('auth.providers.error.status'),
									)}
								>
									{selected.status === 'active'
										? t('auth.providers.disable')
										: t('auth.providers.enable')}
								</Button>
								<Button
									variant="danger"
									disabled={status === 'submitting' ||
										selected.status === 'active'}
									onClick={() => void run(async () => {
										await deleteIdentityProvider(selected.id, props.csrfToken);
										close();
									}, t('auth.providers.error.delete'))}
								>{t('auth.providers.delete')}</Button>
							</div>
						</>
					} @else {
						<Alert tone="info">
							{selected.scope === 'platform'
								? t('auth.providers.scope.platformHint')
								: t('auth.providers.readOnly')}
						</Alert>
					}
				</div>
			}
		</Drawer>
	</div>
}
