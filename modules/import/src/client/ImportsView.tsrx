import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	EmptyState,
	Filters,
	Icon,
	PageHeader,
	Select,
	TableCard,
	Tag,
	ToastHost,
	toasts,
	type TableAction,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client/i18n';
import { useValue } from 'segment-state';
import { IMPORT_JOB_STATUSES, type ImportJobView } from '../domain/types.ts';
import {
	cancelImport,
	continueImport,
	importErrorMessage,
	ImportApiError,
	loadJob,
	loadJobRows,
	loadJobs,
	loadMapping,
	loadTargets,
	saveMapping,
	startImport,
	uploadSourceCsv,
} from './api.ts';
import { ImportJobDrawer } from './ImportJobDrawer.tsrx';
import { NewImportForm, type NewImportValue } from './NewImportForm.tsrx';
import {
	countLabel,
	modeLabel,
	statusLabel,
	statusTone,
	timestampLabel,
} from './presentation.ts';
import { createImportClientState, jobTargets } from './state.ts';

export interface ImportsViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

function columns(): readonly TableColumn<ImportJobView>[] {
	return [
		{
			key: 'target',
			header: t('import.column.target'),
			width: '22%',
			value: (record) => record.target,
			cell: (record) => <span class="ui-cell">
				<b class="ui-mono">{record.target}</b>
				<small class="ui-cell__muted">{timestampLabel(record.startedAt)}</small>
			</span>,
		},
		{
			key: 'status',
			header: t('import.column.status'),
			width: '14%',
			value: (record) => record.status,
			cell: (record) =>
				<Tag tone={statusTone(record.status)} dot>{statusLabel(
					record.status,
				)}</Tag>,
		},
		{
			key: 'mode',
			header: t('import.column.mode'),
			width: '14%',
			value: (record) => record.mode,
			cell: (record) => modeLabel(record.mode),
		},
		{
			key: 'dryRun',
			header: t('import.column.dryRun'),
			width: '10%',
			value: (record) => (record.dryRun ? 1 : 0),
			cell: (record) => record.dryRun
				? t('import.common.yes')
				: t('import.common.no'),
		},
		{
			key: 'totalRows',
			header: t('import.column.totalRows'),
			width: '10%',
			numeric: true,
			value: (record) => record.totalRows,
			cell: (record) => countLabel(record.totalRows),
		},
		{
			key: 'validRows',
			header: t('import.column.validRows'),
			width: '10%',
			numeric: true,
			value: (record) => record.validRows,
			cell: (record) => countLabel(record.validRows),
		},
		{
			key: 'writtenRows',
			header: t('import.column.writtenRows'),
			width: '10%',
			numeric: true,
			value: (record) => record.writtenRows,
			cell: (record) => countLabel(record.writtenRows),
		},
		{
			key: 'failedRows',
			header: t('import.column.failedRows'),
			width: '10%',
			numeric: true,
			value: (record) => record.failedRows,
			cell: (record) => countLabel(record.failedRows),
		},
	];
}

export function ImportsView(props: ImportsViewProps) @{
	const client = useMemo(() => createImportClientState(), []);
	const [jobs] = useValue(client.state.jobs);
	const [targets] = useValue(client.state.targets);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [statusFilter, setStatusFilter] = useValue(client.state.statusFilter);
	const [targetFilter, setTargetFilter] = useValue(client.state.targetFilter);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [formOpen, setFormOpen] = useValue(client.state.formOpen);
	const [formSession, setFormSession] = useValue(client.state.formSession);
	const [openJobId, setOpenJobId] = useValue(client.state.openJobId);
	const [openJob] = useValue(client.state.openJob);
	const [openJobRows] = useValue(client.state.openJobRows);
	const [openJobCursor] = useValue(client.state.openJobCursor);
	const [drawerError, setDrawerError] = useValue(client.state.drawerError);
	const [confirmCancelId, setConfirmCancelId] = useValue(
		client.state.confirmCancelId,
	);

	const filtered = statusFilter !== '' || targetFilter !== '';

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const [page, loadedTargets] = await Promise.all([
				loadJobs({ status: statusFilter, target: targetFilter }),
				loadTargets(),
			]);
			client.store.act((transaction) => {
				transaction.set(client.state.jobs, page.items);
				transaction.set(client.state.targets, loadedTargets);
				transaction.set(client.state.status, 'idle');
			}, 'import/loaded');
		} catch (loadError) {
			setError(importErrorMessage(loadError, 'import.error.load'));
			setStatus(
				loadError instanceof ImportApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const openDrawer = async (id: string) => {
		client.store.act((transaction) => {
			transaction.set(client.state.openJobId, id);
			transaction.set(client.state.openJob, null);
			transaction.set(client.state.openJobRows, []);
			transaction.set(client.state.openJobCursor, null);
			transaction.set(client.state.drawerError, '');
		}, 'import/drawer-open');
		try {
			const [job, rows] = await Promise.all([loadJob(id), loadJobRows(id)]);
			client.store.act((transaction) => {
				transaction.set(client.state.openJob, job);
				transaction.set(client.state.openJobRows, rows.items);
				transaction.set(client.state.openJobCursor, rows.page.nextCursor);
			}, 'import/drawer-loaded');
		} catch (drawerLoadError) {
			setDrawerError(importErrorMessage(drawerLoadError, 'import.error.load'));
		}
	};

	const loadMoreRows = async () => {
		if (!openJobId || openJobCursor === null) return;
		try {
			const rows = await loadJobRows(openJobId, openJobCursor);
			client.store.act((transaction) => {
				transaction.set(client.state.openJobRows, [
					...openJobRows,
					...rows.items,
				]);
				transaction.set(client.state.openJobCursor, rows.page.nextCursor);
			}, 'import/drawer-more');
		} catch (moreError) {
			setDrawerError(importErrorMessage(moreError, 'import.error.load'));
		}
	};

	const submit = async (value: NewImportValue) => {
		setStatus('submitting');
		setError('');
		try {
			/* The bytes enter through documents.core, which applies the session, the
   CSRF proof, the workspace quota and the storage limits. */
			const documentRef = 'import-' + crypto.randomUUID();
			const document = await uploadSourceCsv(
				value.file,
				documentRef,
				props.csrfToken,
			);
			if (value.saveMapping) {
				await saveMapping(value.target, value.columns, props.csrfToken);
			}
			const job = await startImport(
				{
					target: value.target,
					documentId: document.id,
					documentRef,
					mode: value.mode,
					dryRun: value.dryRun,
					columns: value.columns,
				},
				props.csrfToken,
			);
			setFormOpen(false);
			await refresh();
			toasts.success(t('import.notice.started', { target: job.target }));
			await openDrawer(job.id);
		} catch (submitError) {
			setError(importErrorMessage(submitError, 'import.error.start'));
			setStatus('idle');
		}
	};

	const proceed = async (validOnly: boolean) => {
		if (!openJobId) return;
		setStatus('submitting');
		setDrawerError('');
		try {
			await continueImport(openJobId, validOnly, props.csrfToken);
			await refresh();
			await openDrawer(openJobId);
			toasts.success(t('import.notice.continued'));
		} catch (continueError) {
			setDrawerError(
				importErrorMessage(continueError, 'import.error.continue'),
			);
			setStatus('idle');
		}
	};

	const cancel = async () => {
		const id = confirmCancelId;
		setConfirmCancelId(null);
		if (!id) return;
		setStatus('submitting');
		setDrawerError('');
		try {
			await cancelImport(id, props.csrfToken);
			await refresh();
			await openDrawer(id);
			toasts.success(t('import.notice.cancelled'));
		} catch (cancelError) {
			setDrawerError(importErrorMessage(cancelError, 'import.error.cancel'));
			setStatus('idle');
		}
	};

	const rowActions = (record: ImportJobView): readonly TableAction[] => [
		{
			id: 'open',
			label: t('import.action.open'),
			icon: 'external',
			onSelect: () => void openDrawer(record.id),
		},
	];

	<div class="ui-view">
		<PageHeader
			eyebrow={t('import.page.eyebrow')}
			title={t('import.page.title')}
			description={t('import.page.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh()}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('import.common.refreshing')
					: t('import.common.refresh')}
			</Button>
			@if (props.canManage) {
				<Button
					size="sm"
					variant="primary"
					disabled={status === 'denied'}
					onClick={() => {
						client.store.act((transaction) => {
							transaction.set(client.state.formSession, formSession + 1);
							transaction.set(client.state.error, '');
							transaction.set(client.state.formOpen, true);
						}, 'import/form-open');
					}}
				>
					<Icon name="plus" size={14} />
					{t('import.action.new')}
				</Button>
			}
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('import.common.accessDenied')}>{t(
					'import.denied',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (error && !formOpen) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('import.table.title')}
					count={t('import.table.count', { count: jobs.length })}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={(statusFilter === '' ? 0 : 1) +
							(targetFilter === '' ? 0 : 1)}
						label={t('import.common.filters')}
					>
						<Select
							id="import-status"
							label={t('import.filter.status')}
							value={statusFilter}
							options={[
								{ value: '', label: t('import.filter.allStatuses') },
								...IMPORT_JOB_STATUSES.map(
									(value) => ({
										value,
										label: statusLabel(value),
									}),
								),
							]}
							onChange={(value) => {
								setStatusFilter(value as ImportJobView['status'] | '');
								void refresh();
							}}
						/>
						<Select
							id="import-target"
							label={t('import.filter.target')}
							value={targetFilter}
							options={[
								{ value: '', label: t('import.filter.allTargets') },
								...jobTargets(jobs).map((value) => ({ value, label: value })),
							]}
							onChange={(value) => {
								setTargetFilter(value);
								void refresh();
							}}
						/>
					</Filters>}
					caption={t('import.table.caption')}
					columns={columns()}
					rows={jobs}
					rowKey={(record) => record.id}
					sorting
					status={status === 'loading' && jobs.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('import.table.loading')}
					filtered={filtered}
					empty={{
						icon: 'download',
						title: t('import.empty.title'),
						hint: t('import.empty.hint'),
					}}
					emptyFiltered={{
						icon: 'search',
						title: t('import.emptyFiltered.title'),
						hint: t('import.emptyFiltered.hint'),
					}}
					actions={rowActions}
					actionsLabel={t('import.common.actions')}
					actionsWidth="140px"
					noteIcon="shield"
					note={t('import.table.note')}
				/>
			</>
		}
		<Drawer
			open={formOpen}
			title={t('import.form.title')}
			subtitle={t('import.form.subtitle')}
			width="md"
			onClose={() => setFormOpen(false)}
		>
			<NewImportForm
				key={'import-form-' + formSession}
				targets={targets}
				busy={status === 'submitting'}
				error={formOpen ? error : ''}
				loadMapping={async (target) =>
					(await loadMapping(target))?.columns ?? {}}
				onCancel={() => setFormOpen(false)}
				onSubmit={(value) => void submit(value)}
			/>
		</Drawer>
		<Drawer
			open={openJobId !== null}
			title={t('import.job.title')}
			subtitle={openJob?.target ?? ''}
			width="lg"
			onClose={() => setOpenJobId(null)}
		>
			<ImportJobDrawer
				job={openJob}
				rows={openJobRows}
				hasMore={openJobCursor !== null}
				loading={status === 'loading'}
				busy={status === 'submitting'}
				canManage={props.canManage}
				error={drawerError}
				onLoadMore={() => void loadMoreRows()}
				onContinue={(validOnly) => void proceed(validOnly)}
				onCancel={() => setConfirmCancelId(openJobId)}
			/>
		</Drawer>
		<ConfirmDialog
			open={confirmCancelId !== null}
			title={t('import.cancel.title')}
			confirmLabel={t('import.action.cancel')}
			busy={status === 'submitting'}
			onConfirm={() => void cancel()}
			onCancel={() => setConfirmCancelId(null)}
		>{t('import.cancel.description')}</ConfirmDialog>
		<ToastHost
			label={t('import.common.messages')}
			closeLabel={t('import.common.close')}
		/>
	</div>
}
