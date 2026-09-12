import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	DateField,
	Drawer,
	EmptyState,
	FormField,
	Icon,
	Kpi,
	PageHeader,
	SearchField,
	TableCard,
	Tabs,
	Tag,
	type TableColumn,
} from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import { useValue } from 'segment-state';
import { ACCESS_LIMITS } from '../domain/types.ts';
import type {
	AccessReviewMember,
	AccessReviewProvider,
	AccessReviewRole,
	AccessReviewToken,
} from '../domain/types.ts';
import {
	AccessApiError,
	accessErrorMessage,
	loadReview,
	recordAttestation,
} from './api.ts';
import {
	isoDaysBefore,
	memberTone,
	numberLabel,
	screenSurface,
	statusLabel,
	timestampLabel,
	todayIso,
} from './presentation.ts';
import { createReviewClientState, type ReviewTab } from './state.ts';

export interface ReviewViewProps {
	readonly csrfToken: string;
	/** False hides the attestation action, which the server refuses anyway. */
	readonly canAttest: boolean;
}

function memberColumns(): readonly TableColumn<AccessReviewMember>[] {
	return [
		{
			key: 'member',
			header: t('access.review.column.member'),
			width: '26%',
			value: (row) => row.displayName + ' ' + row.email,
			cell: (row) => <span class="ui-cell">
				<b>{row.displayName}</b>
				<small>{row.email}</small>
			</span>,
		},
		{
			key: 'role',
			header: t('access.review.column.role'),
			width: '16%',
			value: (row) => row.role,
			cell: (row) => <span class="ui-mono">{row.role}</span>,
		},
		{
			key: 'status',
			header: t('access.review.column.status'),
			width: '16%',
			value: (row) => row.membershipStatus,
			cell: (row) =>
				<Tag
					tone={memberTone(row.accountStatus, row.membershipStatus)}
					dot
				>{statusLabel(row.membershipStatus)}</Tag>,
		},
		{
			key: 'scopes',
			header: t('access.review.column.scopes'),
			width: '12%',
			numeric: true,
			value: (row) => row.scopeCount,
			cell: (row) => numberLabel(row.scopeCount),
		},
		{
			key: 'extra',
			header: t('access.review.column.extraScopes'),
			width: '30%',
			value: (row) => row.extraScopes.join(' '),
			cell: (row) => row.extraScopes.length === 0
				? <small>{t('access.review.noExtraScopes')}</small>
				: <span class="ui-mono">{row.extraScopes.join(', ')}</span>,
		},
	];
}

function roleColumns(): readonly TableColumn<AccessReviewRole>[] {
	return [
		{
			key: 'role',
			header: t('access.review.column.roleName'),
			width: '28%',
			value: (row) => row.name,
			cell: (row) => <span class="ui-cell">
				<b>{row.name}</b>
				<small class="ui-mono">{row.key}</small>
			</span>,
		},
		{
			key: 'kind',
			header: t('access.review.column.roleKind'),
			width: '16%',
			value: (row) => String(row.builtin),
			cell: (row) =>
				<Tag tone={row.builtin ? 'neutral' : 'info'}>{t(
					row.builtin ? 'access.review.builtin' : 'access.review.custom',
				)}</Tag>,
		},
		{
			key: 'holders',
			header: t('access.review.column.holders'),
			width: '14%',
			numeric: true,
			value: (row) => row.holders,
			cell: (row) => numberLabel(row.holders),
		},
		{
			key: 'scopes',
			header: t('access.review.column.roleScopes'),
			width: '42%',
			value: (row) => row.scopes.join(' '),
			cell: (row) => <span class="ui-mono">{row.scopes.join(', ')}</span>,
		},
	];
}

function tokenColumns(): readonly TableColumn<AccessReviewToken>[] {
	return [
		{
			key: 'label',
			header: t('access.review.column.tokenLabel'),
			width: '24%',
			value: (row) => row.label,
			cell: (row) => <span class="ui-cell">
				<b>{row.label}</b>
				<small class="ui-mono">{row.prefix}</small>
			</span>,
		},
		{
			key: 'holder',
			header: t('access.review.column.tokenHolder'),
			width: '22%',
			value: (row) => row.accountLabel ?? row.accountId,
			cell: (row) =>
				row.accountLabel ?? <span class="ui-mono">{row.accountId}</span>,
		},
		{
			key: 'scopes',
			header: t('access.review.column.tokenScopes'),
			width: '30%',
			value: (row) => row.scopes.join(' '),
			cell: (row) => <span class="ui-mono">{row.scopes.join(', ')}</span>,
		},
		{
			key: 'expires',
			header: t('access.review.column.expires'),
			width: '12%',
			value: (row) => row.expiresAt ?? 0,
			cell: (row) => row.expiresAt === null
				? <small>{t('access.review.noExpiry')}</small>
				: timestampLabel(row.expiresAt),
		},
		{
			key: 'lastUsed',
			header: t('access.review.column.lastUsed'),
			width: '12%',
			value: (row) => row.lastUsedAt ?? 0,
			cell: (row) => timestampLabel(row.lastUsedAt),
		},
	];
}

function providerColumns(): readonly TableColumn<AccessReviewProvider>[] {
	return [
		{
			key: 'provider',
			header: t('access.review.column.provider'),
			width: '26%',
			value: (row) => row.label,
			cell: (row) => <span class="ui-cell">
				<b>{row.label}</b>
				<small class="ui-mono">{row.key}</small>
			</span>,
		},
		{
			key: 'issuer',
			header: t('access.review.column.issuer'),
			width: '30%',
			value: (row) => row.issuer,
			cell: (row) => <span class="ui-mono">{row.issuer}</span>,
		},
		{
			key: 'status',
			header: t('access.review.column.status'),
			width: '14%',
			value: (row) => row.status,
			cell: (row) =>
				<Tag
					tone={row.status === 'active' ? 'success' : 'neutral'}
					dot
				>{statusLabel(row.status)}</Tag>,
		},
		{
			key: 'joining',
			header: t('access.review.column.joining'),
			width: '30%',
			value: (row) => row.jitRole,
			cell: (row) => row.jitEnabled ? t('access.review.jitOn', {
						role: row.jitRole,
						domains: row.allowedDomains.length === 0
							? t('access.review.anyDomain')
							: row.allowedDomains.join(', '),
					}) : t('access.review.jitOff'),
		},
	];
}

export function ReviewView(props: ReviewViewProps) @{
	const client = useMemo(() => createReviewClientState(), []);
	const [review] = useValue(client.state.review);
	const [loaded, setLoaded] = useValue(client.state.loaded);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [tab, setTab] = useValue(client.state.tab);
	const [query, setQuery] = useValue(client.state.query);
	const [attestOpen, setAttestOpen] = useValue(client.state.attestOpen);
	const [attestBusy, setAttestBusy] = useValue(client.state.attestBusy);
	const [attestError, setAttestError] = useValue(client.state.attestError);
	const [attestNote, setAttestNote] = useValue(client.state.attestNote);
	const [attestFrom, setAttestFrom] = useValue(client.state.attestFrom);
	const [attestTo, setAttestTo] = useValue(client.state.attestTo);
	const locale = activeLocale();
	const surface = screenSurface(status);
	const capped = review.capped.includes(tab);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const next = await loadReview();
			client.store.act((transaction) => {
				transaction.set(client.state.review, next);
				transaction.set(client.state.loaded, true);
				transaction.set(client.state.status, 'idle');
			}, 'access/review-loaded');
		} catch (loadError) {
			setError(accessErrorMessage(loadError, 'access.review.error.load'));
			setStatus(
				loadError instanceof AccessApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const openAttestation = () => {
		client.store.act((transaction) => {
			transaction.set(client.state.attestFrom, isoDaysBefore(90));
			transaction.set(client.state.attestTo, todayIso());
			transaction.set(client.state.attestNote, '');
			transaction.set(client.state.attestError, '');
			transaction.set(client.state.attestOpen, true);
		}, 'access/attestation-opened');
	};

	const submitAttestation = async (event: SubmitEvent) => {
		event.preventDefault();
		setAttestBusy(true);
		setAttestError('');
		try {
			await recordAttestation(
				{
					from: attestFrom,
					to: attestTo,
					note: attestNote.trim() === '' ? null : attestNote.trim(),
				},
				props.csrfToken,
			);
			client.store.act((transaction) => {
				transaction.set(client.state.attestOpen, false);
				transaction.set(client.state.attestBusy, false);
			}, 'access/attestation-recorded');
		} catch (submitError) {
			setAttestError(
				accessErrorMessage(submitError, 'access.attest.error.record'),
			);
			setAttestBusy(false);
		}
	};

	const term = query.trim().toLocaleLowerCase(locale);
	const tabs = [
		{
			id: 'members',
			label: t('access.review.tab.members', {
				count: numberLabel(review.counts.members),
			}),
		},
		{
			id: 'roles',
			label: t('access.review.tab.roles', {
				count: numberLabel(review.counts.roles),
			}),
		},
		{
			id: 'tokens',
			label: t('access.review.tab.tokens', {
				count: numberLabel(review.counts.tokens),
			}),
		},
		{
			id: 'providers',
			label: t('access.review.tab.providers', {
				count: numberLabel(review.counts.providers),
			}),
		},
	];
	const tableStatus =
		status === 'loading' && !loaded ? 'loading' : 'idle';
	const note =
		capped
			? t('access.review.cappedNote', {
					count: numberLabel(
						tab === 'members'
							? ACCESS_LIMITS.members
							: tab === 'roles'
								? ACCESS_LIMITS.roles
								: tab === 'tokens'
									? ACCESS_LIMITS.tokens
									: ACCESS_LIMITS.providers,
					),
				})
			: t('access.review.note');

	<div class="ui-view">
		<PageHeader
			eyebrow={t('access.common.administration')}
			title={t('access.review.title')}
			description={t('access.review.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh()}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('access.common.refreshing')
					: t('access.common.refresh')}
			</Button>
			@if (props.canAttest) {
				<Button
					size="sm"
					variant="primary"
					disabled={status !== 'idle' || !loaded}
					onClick={openAttestation}
				>
					<Icon name="check" size={14} />
					{t('access.attest.action')}
				</Button>
			}
		</PageHeader>
		@if (surface === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('access.common.accessDenied')}>{t(
					'access.review.denied',
				)}</EmptyState>
			</section>
		} @else if (surface === 'error') {
			<Alert>{error}</Alert>
		} @else {
			<>
				<div class="ui-kpi-grid">
					<Kpi
						label={t('access.review.kpi.members')}
						value={numberLabel(review.counts.members)}
						note={t('access.review.kpi.membersNote', {
							count: numberLabel(review.counts.activeMembers),
						})}
					/>
					<Kpi
						label={t('access.review.kpi.extraScopes')}
						value={numberLabel(review.counts.extraScopeGrants)}
						note={t('access.review.kpi.extraScopesNote')}
					/>
					<Kpi
						label={t('access.review.kpi.tokens')}
						value={numberLabel(review.counts.tokens)}
						note={t('access.review.kpi.tokensNote')}
					/>
					<Kpi
						label={t('access.review.kpi.providers')}
						value={numberLabel(review.counts.providers)}
						note={t('access.review.kpi.providersNote')}
					/>
				</div>
				<Tabs
					id="access-review"
					items={tabs}
					active={tab}
					onChange={(id: string) => setTab(id as ReviewTab)}
					label={t('access.review.tabsLabel')}
				/>
				<div id={'access-review-panel-' + tab} role="tabpanel">
					@if (tab === 'members') {
						<TableCard
							title={t('access.review.members.title')}
							count={t('access.review.members.count', {
								count: numberLabel(review.members.length),
							})}
							search={<SearchField
								value={query}
								placeholder={t('access.review.search.placeholder')}
								label={t('access.review.search.label')}
								onInput={(value: string) => setQuery(value)}
							/>}
							caption={t('access.review.members.caption')}
							columns={memberColumns()}
							rows={review.members}
							rowKey={(row) => row.accountId}
							globalFilter={term}
							filtered={term !== ''}
							status={tableStatus}
							loadingLabel={t('access.common.loading')}
							empty={{
								icon: 'users',
								title: t('access.review.members.emptyTitle'),
								hint: t('access.review.members.emptyHint'),
							}}
							emptyFiltered={{
								icon: 'search',
								title: t('access.common.noMatchTitle'),
								hint: t('access.common.noMatchHint'),
							}}
							noteIcon="shield"
							note={note}
						/>
					} @else if (tab === 'roles') {
						<TableCard
							title={t('access.review.roles.title')}
							count={t('access.review.roles.count', {
								count: numberLabel(review.roles.length),
							})}
							caption={t('access.review.roles.caption')}
							columns={roleColumns()}
							rows={review.roles}
							rowKey={(row) => row.id}
							status={tableStatus}
							loadingLabel={t('access.common.loading')}
							empty={{
								icon: 'key',
								title: t('access.review.roles.emptyTitle'),
								hint: t('access.review.roles.emptyHint'),
							}}
							noteIcon="shield"
							note={note}
						/>
					} @else if (tab === 'tokens') {
						<TableCard
							title={t('access.review.tokens.title')}
							count={t('access.review.tokens.count', {
								count: numberLabel(review.tokens.length),
							})}
							caption={t('access.review.tokens.caption')}
							columns={tokenColumns()}
							rows={review.tokens}
							rowKey={(row) => row.id}
							status={tableStatus}
							loadingLabel={t('access.common.loading')}
							empty={{
								icon: 'key',
								title: t('access.review.tokens.emptyTitle'),
								hint: t('access.review.tokens.emptyHint'),
							}}
							noteIcon="shield"
							note={t('access.review.tokens.note')}
						/>
					} @else {
						<TableCard
							title={t('access.review.providers.title')}
							count={t('access.review.providers.count', {
								count: numberLabel(review.providers.length),
							})}
							caption={t('access.review.providers.caption')}
							columns={providerColumns()}
							rows={review.providers}
							rowKey={(row) => row.id}
							status={tableStatus}
							loadingLabel={t('access.common.loading')}
							empty={{
								icon: 'globe',
								title: t('access.review.providers.emptyTitle'),
								hint: t('access.review.providers.emptyHint'),
							}}
							noteIcon="info"
							note={t('access.review.providers.note')}
						/>
					}
				</div>
			</>
		}
		<Drawer
			open={attestOpen}
			title={t('access.attest.title')}
			subtitle={t('access.attest.subtitle')}
			onClose={() => setAttestOpen(false)}
		>
			<form class="ui-drawer__form" onSubmit={submitAttestation}>
				<div class="ui-drawer__body">
					<div class="ui-form">
						<div class="ui-form__row">
							<DateField
								id="access-attest-from"
								label={t('access.attest.from')}
								value={attestFrom}
								locale={locale}
								max={attestTo}
								required
								onChange={(value: string) => setAttestFrom(value)}
							/>
							<DateField
								id="access-attest-to"
								label={t('access.attest.to')}
								value={attestTo}
								locale={locale}
								min={attestFrom}
								required
								onChange={(value: string) => setAttestTo(value)}
							/>
						</div>
						<FormField
							label={t('access.attest.note')}
							help={t('access.attest.noteHelp')}
						>
							<textarea
								class="ui-textarea"
								name="note"
								rows={4}
								maxlength={ACCESS_LIMITS.note}
								value={attestNote}
								onInput={(event) => setAttestNote(event.currentTarget.value)}
							/>
						</FormField>
						@if (attestError) {
							<Alert>{attestError}</Alert>
						}
					</div>
				</div>
				<div class="ui-drawer__foot">
					<small>{t('access.attest.evidence', {
						members: numberLabel(review.counts.members),
						scopes: numberLabel(review.counts.extraScopeGrants),
						tokens: numberLabel(review.counts.tokens),
					})}</small>
					<div class="ui-form__actions">
						<Button onClick={() => setAttestOpen(false)}>{t(
							'access.common.cancel',
						)}</Button>
						<Button variant="primary" type="submit" disabled={attestBusy}>
							{attestBusy
								? t('access.attest.recording')
								: t('access.attest.record')}
						</Button>
					</div>
				</div>
			</form>
		</Drawer>
	</div>
}
