import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	EmptyState,
	Icon,
	PageHeader,
	TableCard,
	Tabs,
	Tag,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import {
	loadEvidence,
	loadEvidenceDetail,
	loadQueries,
	ResearchApiError,
	researchErrorMessage,
	type ResearchEvidenceRow,
	type ResearchQueryRow,
} from './api.ts';
import { EvidenceDrawer } from './EvidenceDrawer.tsrx';
import {
	adapterLabel,
	callerLabel,
	numberLabel,
	screenSurface,
	shortDigest,
	timestampLabel,
} from './presentation.ts';
import { createResearchClientState, type ResearchTab } from './state.ts';

export interface ResearchViewProps {
	readonly initialTab: ResearchTab;
	/** Evidence opened in the drawer as the screen loads, from the address. */
	readonly evidenceId: string | null;
}

function evidenceColumns(): readonly TableColumn<ResearchEvidenceRow>[] {
	return [
		{
			key: 'retrievedAt',
			header: t('research.evidence.column.retrievedAt'),
			width: '18%',
			value: (row) => row.retrievedAt,
			cell: (row) => timestampLabel(row.retrievedAt),
		},
		{
			key: 'title',
			header: t('research.evidence.column.title'),
			width: '46%',
			value: (row) => row.title,
			cell: (row) => <span class="ui-cell">
				<b>{row.title || t('research.evidence.untitled')}</b>
				<small class="ui-mono">{row.url}</small>
			</span>,
		},
		{
			key: 'runId',
			header: t('research.evidence.column.runId'),
			width: '18%',
			value: (row) => row.runId ?? '',
			cell: (row) => row.runId === null
				? <Tag>{t('research.evidence.member')}</Tag>
				: <span class="ui-mono">{row.runId}</span>,
		},
		{
			key: 'contentSha256',
			header: t('research.evidence.column.contentSha256'),
			width: '18%',
			value: (row) => row.contentSha256,
			cell: (row) =>
				<span class="ui-mono">{shortDigest(row.contentSha256)}</span>,
		},
	];
}

function queryColumns(): readonly TableColumn<ResearchQueryRow>[] {
	return [
		{
			key: 'createdAt',
			header: t('research.queries.column.createdAt'),
			width: '18%',
			value: (row) => row.createdAt,
			cell: (row) => timestampLabel(row.createdAt),
		},
		{
			key: 'query',
			header: t('research.queries.column.query'),
			width: '34%',
			value: (row) => row.query,
			cell: (row) => row.query,
		},
		{
			key: 'adapter',
			header: t('research.queries.column.adapter'),
			width: '14%',
			value: (row) => row.adapter,
			cell: (row) => <Tag>{adapterLabel(row.adapter)}</Tag>,
		},
		{
			key: 'caller',
			header: t('research.queries.column.caller'),
			width: '12%',
			value: (row) => row.caller,
			cell: (row) => callerLabel(row.caller),
		},
		{
			key: 'resultCount',
			header: t('research.queries.column.resultCount'),
			width: '11%',
			numeric: true,
			value: (row) => row.resultCount,
			cell: (row) => numberLabel(row.resultCount),
		},
		{
			key: 'costUnits',
			header: t('research.queries.column.costUnits'),
			width: '11%',
			numeric: true,
			value: (row) => row.costUnits,
			cell: (row) => numberLabel(row.costUnits),
		},
	];
}

export function ResearchView(props: ResearchViewProps) @{
	const client = useMemo(() => createResearchClientState(props.initialTab), []);
	const [tab, setTab] = useValue(client.state.tab);
	const [evidence] = useValue(client.state.evidence);
	const [evidenceCursor] = useValue(client.state.evidenceCursor);
	const [evidenceLoaded] = useValue(client.state.evidenceLoaded);
	const [queries] = useValue(client.state.queries);
	const [queriesCursor] = useValue(client.state.queriesCursor);
	const [queriesLoaded] = useValue(client.state.queriesLoaded);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [selectedId, setSelectedId] = useValue(client.state.selectedId);
	const [detail, setDetail] = useValue(client.state.detail);
	const [detailStatus, setDetailStatus] = useValue(client.state.detailStatus);
	const [detailError, setDetailError] = useValue(client.state.detailError);
	const surface = screenSurface(status);

	const failed = (loadError: unknown, fallbackKey: string) => {
		setError(researchErrorMessage(loadError, fallbackKey));
		setStatus(
			loadError instanceof ResearchApiError && loadError.status === 403
				? 'denied'
				: 'error',
		);
	};

	const loadEvidencePage = async (cursor: string | null) => {
		setStatus('loading');
		setError('');
		try {
			const page = await loadEvidence(cursor);
			client.store.act((transaction) => {
				transaction.set(
					client.state.evidence,
					cursor === null ? page.items : [...evidence, ...page.items],
				);
				transaction.set(client.state.evidenceCursor, page.page.nextCursor);
				transaction.set(client.state.evidenceLoaded, true);
				transaction.set(client.state.status, 'idle');
			}, 'research/evidence-loaded');
		} catch (loadError) {
			failed(loadError, 'research.evidence.error.load');
		}
	};

	const loadQueryPage = async (cursor: string | null) => {
		setStatus('loading');
		setError('');
		try {
			const page = await loadQueries(cursor);
			client.store.act((transaction) => {
				transaction.set(
					client.state.queries,
					cursor === null ? page.items : [...queries, ...page.items],
				);
				transaction.set(client.state.queriesCursor, page.page.nextCursor);
				transaction.set(client.state.queriesLoaded, true);
				transaction.set(client.state.status, 'idle');
			}, 'research/queries-loaded');
		} catch (loadError) {
			failed(loadError, 'research.queries.error.load');
		}
	};

	const openEvidence = async (id: string) => {
		setSelectedId(id);
		setDetail(null);
		setDetailError('');
		setDetailStatus('loading');
		try {
			const loaded = await loadEvidenceDetail(id);
			client.store.act((transaction) => {
				transaction.set(client.state.detail, loaded);
				transaction.set(client.state.detailStatus, 'idle');
			}, 'research/evidence-opened');
		} catch (loadError) {
			setDetailError(
				researchErrorMessage(loadError, 'research.evidence.error.detail'),
			);
			setDetailStatus('error');
		}
	};

	const refresh = () => void ((tab === 'evidence'
		? loadEvidencePage(null)
		: loadQueryPage(null)));

	const switchTab = (next: string) => {
		const chosen: ResearchTab =
			next === 'queries' ? 'queries' : 'evidence';
		setTab(chosen);
		if (chosen === 'queries' && !queriesLoaded) void loadQueryPage(null);
		if (chosen === 'evidence' && !evidenceLoaded) void loadEvidencePage(null);
	};

	useEffect(() => {
		refresh();
		if (props.evidenceId !== null) void openEvidence(props.evidenceId);
	}, []);

	<div class="ui-view">
		<PageHeader
			eyebrow={t('research.common.administration')}
			title={t('research.title')}
			description={t('research.description')}
		>
			<Button size="sm" disabled={status === 'denied'} onClick={refresh}>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('research.common.refreshing')
					: t('research.common.refresh')}
			</Button>
		</PageHeader>
		@if (surface === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('research.common.accessDenied')}>{t(
					'research.denied',
				)}</EmptyState>
			</section>
		} @else {
			<>
				<Tabs
					id="research"
					items={[
						{ id: 'evidence', label: t('research.tab.evidence') },
						{ id: 'queries', label: t('research.tab.queries') },
					]}
					active={tab}
					onChange={switchTab}
					label={t('research.tabsLabel')}
				/>
				<div id={'research-panel-' + tab} role="tabpanel">
					@if (surface === 'error') {
						<Alert>{error}</Alert>
					} @else if (tab === 'evidence') {
						<TableCard
							title={t('research.evidence.table.title')}
							count={t('research.evidence.count', { count: evidence.length })}
							caption={t('research.evidence.caption')}
							columns={evidenceColumns()}
							rows={evidence}
							rowKey={(row) => row.id}
							onSelect={(row) => void openEvidence(row.id)}
							selectedKey={selectedId ?? undefined}
							status={status === 'loading' && !evidenceLoaded
								? 'loading'
								: 'idle'}
							loadingLabel={t('research.common.loading')}
							empty={{
								icon: 'globe',
								title: t('research.evidence.emptyTitle'),
								hint: t('research.evidence.emptyHint'),
							}}
							after={evidenceCursor === null
								? undefined
								: <div class="ui-form__actions">
										<Button
											size="sm"
											disabled={status === 'loading'}
											onClick={() => void loadEvidencePage(evidenceCursor)}
										>{t('research.common.more')}</Button>
									</div>}
							noteIcon="shield"
							note={t('research.evidence.note')}
						/>
					} @else {
						<TableCard
							title={t('research.queries.table.title')}
							count={t('research.queries.count', { count: queries.length })}
							caption={t('research.queries.caption')}
							columns={queryColumns()}
							rows={queries}
							rowKey={(row) => row.id}
							status={status === 'loading' && !queriesLoaded
								? 'loading'
								: 'idle'}
							loadingLabel={t('research.common.loading')}
							empty={{
								icon: 'search',
								title: t('research.queries.emptyTitle'),
								hint: t('research.queries.emptyHint'),
							}}
							after={queriesCursor === null
								? undefined
								: <div class="ui-form__actions">
										<Button
											size="sm"
											disabled={status === 'loading'}
											onClick={() => void loadQueryPage(queriesCursor)}
										>{t('research.common.more')}</Button>
									</div>}
							noteIcon="info"
							note={t('research.queries.note')}
						/>
					}
				</div>
			</>
		}
		<EvidenceDrawer
			open={selectedId !== null}
			detail={detail}
			status={detailStatus}
			error={detailError}
			onClose={() => {
				setSelectedId(null);
				setDetail(null);
			}}
		/>
	</div>
}
