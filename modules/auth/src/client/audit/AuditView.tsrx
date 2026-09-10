import { useEffect, useMemo } from 'octane';
import { activeLocale, t } from '@flowdular/client';
import {
	Alert,
	Button,
	EmptyState,
	Filters,
	Icon,
	PageHeader,
	SearchField,
	TableCard,
	Tag,
} from '@flowdular/ui';
import { cell, createStore, useValue } from 'segment-state';
import {
	ApiError,
	loadAuditSource,
	verifyAuditSource,
	type AuditRow,
	type AuditSource,
	type AuditVerification,
} from './api.ts';
import { auditColumns } from './audit-columns.tsrx';

type AuditStatus = 'loading' | 'idle' | 'denied' | 'error';
type VerifyStatus = 'idle' | 'loading' | 'error';

const SOURCE_ORDER: readonly AuditSource[] = ['platform', 'agents', 'sandbox'];

const SOURCE_SCOPE: Readonly<Record<AuditSource, string>> = {
	platform: 'auth.audit.read',
	agents: 'agents.runs.read',
	sandbox: 'sandbox.sessions.read',
};

/* A denied source shows its own empty state instead of the last source's rows. */
const NO_ROWS: readonly AuditRow[] = [];

export interface AuditViewProps {
	readonly scopes: readonly string[];
}

function createAuditState(initial: AuditSource) {
	const store = createStore({
		source: cell<AuditSource>(initial),
		rows: cell<readonly AuditRow[]>([]),
		actions: cell<readonly string[]>([]),
		nextCursor: cell<string | null>(null),
		status: cell<AuditStatus>('loading'),
		verification: cell<AuditVerification | null>(null),
		verifyStatus: cell<VerifyStatus>('idle'),
		error: '',
		action: '',
		actor: '',
		search: '',
		filtersOpen: false,
	});
	return { store, state: store.state };
}

function matches(row: AuditRow, term: string, locale: string): boolean {
	if (term === '') return true;
	return row.actor.toLocaleLowerCase(locale).includes(term) ||
		row.action.toLocaleLowerCase(locale).includes(term) ||
		row.subjectType.toLocaleLowerCase(locale).includes(term) ||
		row.subjectId.toLocaleLowerCase(locale).includes(term);
}

export function AuditView(props: AuditViewProps) @{
	const available = useMemo(
		() => SOURCE_ORDER.filter(
			(source) => props.scopes.includes(SOURCE_SCOPE[source]),
		),
		[],
	);
	const client = useMemo(
		() => createAuditState(available[0] ?? 'platform'),
		[],
	);
	const [source] = useValue(client.state.source);
	const [rows] = useValue(client.state.rows);
	const [actions] = useValue(client.state.actions);
	const [nextCursor] = useValue(client.state.nextCursor);
	const [status] = useValue(client.state.status);
	const [verification] = useValue(client.state.verification);
	const [verifyStatus] = useValue(client.state.verifyStatus);
	const [error] = useValue(client.state.error);
	const [action, setAction] = useValue(client.state.action);
	const [actor, setActor] = useValue(client.state.actor);
	const [search, setSearch] = useValue(client.state.search);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);

	/* Platform filters by action/actor on the server; the chained trails do not,
   so the same fields also narrow their loaded rows here. Search always runs
   over the loaded page. */
	const locale = activeLocale();
	const term = search.trim().toLocaleLowerCase(locale);
	const actorTerm = actor.trim().toLocaleLowerCase(locale);
	const visible = rows.filter(
		(row) =>
			matches(row, term, locale) && (action === '' || row.action === action) &&
				(actorTerm === '' ||
					row.actor.toLocaleLowerCase(locale).includes(actorTerm)),
	);
	const filtersActive = (action !== '' ? 1 : 0) + (actor.trim() !== '' ? 1 : 0);

	const runLoad = async (
		src: AuditSource,
		cursor: string | null,
		filterAction: string,
		filterActor: string,
	) => {
		client.store.act((transaction) => {
			transaction.set(client.state.status, 'loading');
			transaction.set(client.state.error, '');
		}, 'audit/loading');
		try {
			const page = await loadAuditSource(src, {
				action: filterAction,
				actor: filterActor.trim(),
				cursor,
			});
			client.store.act((transaction) => {
				transaction.set(
					client.state.rows,
					cursor ? [...rows, ...page.rows] : page.rows,
				);
				transaction.set(client.state.actions, page.actions);
				transaction.set(client.state.nextCursor, page.nextCursor);
				transaction.set(client.state.status, 'idle');
			}, 'audit/loaded');
		} catch (loadError) {
			client.store.act((transaction) => {
				transaction.set(
					client.state.error,
					loadError instanceof Error
						? loadError.message
						: t('auth.audit.error.load'),
				);
				transaction.set(
					client.state.status,
					loadError instanceof ApiError && loadError.status === 403
						? 'denied'
						: 'error',
				);
			}, 'audit/failed');
		}
	};

	const runVerify = async (src: AuditSource) => {
		if (src === 'platform') {
			client.store.act((transaction) => {
				transaction.set(client.state.verification, null);
				transaction.set(client.state.verifyStatus, 'idle');
			}, 'audit/verify-skip');
			return;
		}
		client.store.act((transaction) => {
			transaction.set(client.state.verification, null);
			transaction.set(client.state.verifyStatus, 'loading');
		}, 'audit/verifying');
		try {
			const result = await verifyAuditSource(src);
			client.store.act((transaction) => {
				transaction.set(client.state.verification, result);
				transaction.set(client.state.verifyStatus, 'idle');
			}, 'audit/verified');
		} catch {
			client.store.act(
				(transaction) => transaction.set(client.state.verifyStatus, 'error'),
				'audit/verify-failed',
			);
		}
	};

	const refresh = () => {
		void runLoad(source, null, action, actor);
		void runVerify(source);
	};

	const selectSource = (next: AuditSource) => {
		client.store.act((transaction) => {
			transaction.set(client.state.source, next);
			transaction.set(client.state.rows, []);
			transaction.set(client.state.nextCursor, null);
			transaction.set(client.state.action, '');
			transaction.set(client.state.actor, '');
			transaction.set(client.state.search, '');
			transaction.set(client.state.filtersOpen, false);
			transaction.set(client.state.verification, null);
		}, 'audit/source');
		void runLoad(next, null, '', '');
		void runVerify(next);
	};

	useEffect(() => {
		if (available.length > 0) refresh();
	}, []);

	<div class="ui-view">
		<PageHeader
			eyebrow={t('auth.common.administration')}
			title={t('auth.audit.title')}
			description={t('auth.audit.description')}
		>
			<Button
				size="sm"
				disabled={available.length === 0}
				onClick={() => refresh()}
			>
				<Icon name="refresh" size={14} />
				{t('auth.common.refresh')}
			</Button>
		</PageHeader>
		@if (available.length === 0) {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('auth.common.accessDenied')}>{t(
					'auth.audit.denied',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (status === 'error') {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('auth.audit.table.title')}
					count={t('auth.audit.table.count', { count: visible.length })}
					head={<>
						@if (source !== 'platform') {
							@if (verifyStatus === 'loading') {
								<Tag tone="neutral" dot>{t(
									'auth.audit.integrity.checking',
								)}</Tag>
							} @else if (verification) {
								<Tag tone={verification.verified ? 'success' : 'danger'} dot>
									{verification.verified
										? t('auth.audit.integrity.verified')
										: verification.brokenAt
											? t('auth.audit.integrity.tamperedAt', {
													id: verification.brokenAt,
												})
											: t('auth.audit.integrity.tampered')}
								</Tag>
							} @else if (verifyStatus === 'error') {
								<Tag tone="warning" dot>{t(
									'auth.audit.integrity.unknown',
								)}</Tag>
							}
						}
						<select
							class="ui-select"
							aria-label={t('auth.audit.source.label')}
							value={source}
							onInput={(event) => selectSource(
								(event.currentTarget as HTMLSelectElement).value as AuditSource,
							)}
						>
							@for (const entry of available; key entry) {
								<option value={entry}>{t('auth.audit.source.' + entry)}</option>
							}
						</select>
					</>}
					search={<SearchField
						value={search}
						placeholder={t('auth.audit.search.placeholder')}
						label={t('auth.audit.search.label')}
						onInput={setSearch}
					/>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={filtersActive}
					>
						<label class="ui-label">{t('auth.audit.filter.action')}</label>
						<select
							class="ui-select"
							aria-label={t('auth.audit.filter.action')}
							value={action}
							onInput={(event) => setAction(
								(event.currentTarget as HTMLSelectElement).value,
							)}
						>
							<option value="">{t('auth.audit.filter.allActions')}</option>
							@for (const entry of actions; key entry) {
								<option value={entry}>{entry}</option>
							}
						</select>
						<label class="ui-label">{t('auth.audit.filter.actor')}</label>
						<input
							class="ui-input"
							aria-label={t('auth.audit.filter.actor')}
							placeholder={t('auth.audit.filter.actorPlaceholder')}
							value={actor}
							maxlength={254}
							onInput={(event) => setActor(
								(event.currentTarget as HTMLInputElement).value,
							)}
						/>
						<Button
							block
							disabled={status === 'loading'}
							onClick={() => {
								setFiltersOpen(false);
								void runLoad(source, null, action, actor);
							}}
						>
							<Icon name="filter" size={14} />
							{t('auth.audit.filter.apply')}
						</Button>
					</Filters>}
					caption={t('auth.audit.table.caption')}
					columns={auditColumns()}
					rows={status === 'denied' ? NO_ROWS : visible}
					rowKey={(row) => row.id}
					status={status === 'loading' && rows.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('auth.audit.loading')}
					filtered={status !== 'denied' && rows.length > 0}
					empty={status === 'denied'
						? {
								icon: 'shield',
								title: t('auth.common.accessDenied'),
								hint: t('auth.audit.empty.deniedHint'),
							}
						: {
								icon: 'activity',
								title: t('auth.audit.empty.title'),
								hint: t('auth.audit.empty.hint'),
							}}
					emptyFiltered={{
						icon: 'activity',
						title: t('auth.audit.empty.filteredTitle'),
						hint: t('auth.audit.empty.filteredHint'),
					}}
					after={nextCursor
						? <div class="ui-toolbar">
								<span class="ui-toolbar__spacer"></span>
								<Button
									disabled={status === 'loading'}
									onClick={() => void runLoad(
										source,
										nextCursor,
										action,
										actor,
									)}
								>{t('auth.audit.loadOlder')}</Button>
							</div>
						: null}
					noteIcon="shield"
					note={t('auth.audit.note')}
				/>
			</>
		}
	</div>
}
