import { useEffect, useMemo } from 'octane';
import { t } from '@flowdular/client/i18n';
import {
	Alert,
	Button,
	EmptyState,
	Icon,
	PageHeader,
	Select,
	Tag,
	TableCard,
	type TableColumn,
} from '@flowdular/ui';
import { useValue } from 'segment-state';
import {
	EXPORT_JOB_STATUSES,
	type ExportJobStatus,
	type ExportJobView,
} from '../domain/types.ts';
import {
	exportErrorMessage,
	exportReadUrl,
	ExportApiError,
	loadExportJobs,
	loadExportLists,
	startExport,
} from './api.ts';
import {
	byteLabel,
	countLabel,
	failureLabel,
	statusLabel,
	statusTone,
	timestampLabel,
} from './presentation.ts';
import {
	createExportsClientState,
	startableLists,
	startState,
} from './state.ts';

export interface ExportsViewProps {
	readonly csrfToken: string;
	/** Whether the reader holds exports.lists.manage; the server decides again. */
	readonly canManage: boolean;
}

export function ExportsView(props: ExportsViewProps) @{
	const client = useMemo(() => createExportsClientState(), []);
	const [jobs] = useValue(client.state.jobs);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [statusFilter, setStatusFilter] = useValue(client.state.statusFilter);
	const [openingId] = useValue(client.state.openingId);
	const [lists, setLists] = useValue(client.state.lists);
	const [listsStatus, setListsStatus] = useValue(client.state.listsStatus);
	const [listsError, setListsError] = useValue(client.state.listsError);
	const [selectedListId, setSelectedListId] = useValue(
		client.state.selectedListId,
	);
	const [starting, setStarting] = useValue(client.state.starting);

	const refresh = async (filter: ExportJobStatus | '') => {
		setStatus('loading');
		setError('');
		try {
			const page = await loadExportJobs({ status: filter });
			client.store.act((transaction) => {
				transaction.set(client.state.jobs, page.items);
				transaction.set(client.state.nextCursor, page.nextCursor);
			}, 'exports/loaded');
			setStatus('idle');
		} catch (loadError) {
			setError(exportErrorMessage(loadError, 'exports.error.load'));
			setStatus(
				loadError instanceof ExportApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	/* The catalogue is sealed at boot, so it is read once and not per refresh. */
	const loadLists = async () => {
		setListsStatus('loading');
		setListsError('');
		try {
			setLists(await loadExportLists());
			setListsStatus('idle');
		} catch (catalogueError) {
			setListsError(
				exportErrorMessage(catalogueError, 'exports.error.catalogue'),
			);
			setListsStatus(
				catalogueError instanceof ExportApiError &&
				catalogueError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh('');
		if (props.canManage) void loadLists();
	}, []);

	/* The job appears in the table the moment it is recorded, so the reader sees
   the work queued rather than an acknowledgement they have to trust. */
	const begin = async () => {
		if (selectedListId === '') return;
		setStarting(true);
		setError('');
		try {
			await startExport(props.csrfToken, selectedListId);
			await refresh(statusFilter);
		} catch (startError) {
			setError(exportErrorMessage(startError, 'exports.error.start'));
		} finally {
			setStarting(false);
		}
	};

	/* The signed route is minted on the click and used at once, so the screen
   never holds a credential it could re-render or log. */
	const open = async (job: ExportJobView) => {
		client.store.act(
			(transaction) => transaction.set(client.state.openingId, job.id),
			'exports/opening',
		);
		setError('');
		try {
			const url = await exportReadUrl(props.csrfToken, job.id);
			globalThis.location.assign(url);
		} catch (openError) {
			setError(exportErrorMessage(openError, 'exports.error.open'));
		} finally {
			client.store.act(
				(transaction) => transaction.set(client.state.openingId, null),
				'exports/opened',
			);
		}
	};

	const start = startState(listsStatus, lists);

	const columns = (): readonly TableColumn<ExportJobView>[] => [
		{
			key: 'listId',
			header: t('exports.table.column.listId'),
			width: '30%',
			value: (job) => job.listId,
			cell: (job) => <b>{job.listId}</b>,
		},
		{
			key: 'status',
			header: t('exports.table.column.status'),
			width: '16%',
			value: (job) => statusLabel(job.status),
			cell: (job) =>
				<Tag tone={statusTone(job.status)}>{statusLabel(job.status)}</Tag>,
		},
		{
			key: 'rowCount',
			header: t('exports.table.column.rowCount'),
			width: '12%',
			numeric: true,
			value: (job) => job.rowCount,
			cell: (job) => countLabel(job.rowCount),
		},
		{
			key: 'byteCount',
			header: t('exports.table.column.byteCount'),
			width: '12%',
			numeric: true,
			value: (job) => job.byteCount,
			cell: (job) => byteLabel(job.byteCount),
		},
		{
			key: 'startedAt',
			header: t('exports.table.column.startedAt'),
			width: '18%',
			value: (job) => job.startedAt,
			cell: (job) => timestampLabel(job.startedAt),
		},
		{
			key: 'file',
			header: t('exports.table.column.file'),
			width: '12%',
			cell: (job) => job.downloadable
				? <Button
						size="sm"
						disabled={openingId !== null}
						onClick={() => void open(job)}
					>
						<Icon name="download" size={14} />
						{t('exports.action.open')}
					</Button>
				: <span class="ui-cell__muted">{failureLabel(job.failureCode)}</span>,
		},
	];

	<div class="ui-view">
		<PageHeader
			eyebrow={t('exports.page.eyebrow')}
			title={t('exports.page.title')}
			description={t('exports.page.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh(statusFilter)}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('exports.action.refreshing')
					: t('exports.action.refresh')}
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('exports.denied.title')}>{t(
					'exports.denied.hint',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (props.canManage) {
					<section class="ui-card">
						<div class="ui-card__head">
							<span class="ui-card__title">
								{t('exports.start.title')}
								<small>{t('exports.start.description')}</small>
							</span>
						</div>
						<div class="ui-form">
							@if (start === 'denied') {
								<EmptyState
									icon="shield"
									title={t('exports.start.deniedTitle')}
								>{t('exports.start.deniedHint')}</EmptyState>
							} @else if (start === 'error') {
								<Alert>{listsError}</Alert>
							} @else if (start === 'loading') {
								<p class="ui-note">
									<Icon name="refresh" size={14} />
									<span>{t('exports.start.loading')}</span>
								</p>
							} @else if (start === 'empty') {
								<EmptyState
									icon="download"
									title={t('exports.start.emptyTitle')}
								>{t('exports.start.emptyHint')}</EmptyState>
							} @else {
								<>
									<Select
										id="exports-start-list"
										label={t('exports.start.list')}
										placeholder={t('exports.start.placeholder')}
										value={selectedListId}
										disabled={starting}
										onChange={(value) => setSelectedListId(value)}
										options={startableLists(lists).map(
											(entry) => ({
												value: entry.id,
												label: entry.label + ' (' + entry.moduleId + ')',
											}),
										)}
									/>
									<div class="ui-form__actions">
										<Button
											disabled={starting || selectedListId === ''}
											onClick={() => void begin()}
										>
											<Icon name="play" size={14} />
											{starting
												? t('exports.action.starting')
												: t('exports.action.start')}
										</Button>
									</div>
								</>
							}
						</div>
					</section>
				}
				@if (error) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('exports.table.title')}
					count={t('exports.table.count', { count: jobs.length })}
					caption={t('exports.table.caption')}
					columns={columns()}
					rows={jobs}
					rowKey={(job) => job.id}
					status={status === 'loading' && jobs.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('exports.table.loading')}
					empty={{
						icon: 'download',
						title: t('exports.table.emptyTitle'),
						hint: t('exports.table.emptyHint'),
					}}
					filters={<Select
						id="exports-status-filter"
						label={t('exports.filter.status')}
						value={statusFilter}
						onChange={(value) => {
							setStatusFilter(value as ExportJobStatus | '');
							void refresh(value as ExportJobStatus | '');
						}}
						options={[
							{ value: '', label: t('exports.filter.any') },
							...EXPORT_JOB_STATUSES.map(
								(value) => ({
									value,
									label: statusLabel(value),
								}),
							),
						]}
					/>}
				/>
			</>
		}
	</div>
}
