import { useEffect, useMemo, useState } from 'octane';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	EmptyState,
	Filters,
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
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import type { DocumentAttachment } from '../domain/attachments.ts';
import { DOCUMENT_SCANS, type DocumentScan } from '../domain/types.ts';
import {
	deleteDocument,
	documentReadUrl,
	documentsErrorMessage,
	DocumentsApiError,
	loadDocumentLimits,
	loadDocuments,
	uploadDocument,
	type DocumentLimits,
} from './api.ts';
import { DownloadBlocked, runDownload } from './download.ts';
import {
	DocumentUploader,
	type DocumentUploadValue,
} from './DocumentUploader.tsrx';
import {
	byteLabel,
	downloadAction,
	scanLabel,
	scanTone,
	tableEmpty,
	timestampLabel,
} from './presentation.ts';
import {
	createDocumentsClientState,
	mergeDocumentPage,
	mergeOwnerModules,
	searchPending,
} from './state.ts';

export interface DocumentsViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

/** How long the typing rests before the term is sent as a filter. */
const SEARCH_DEBOUNCE_MS = 300;

function columns(): readonly TableColumn<DocumentAttachment>[] {
	return [
		{
			key: 'filename',
			header: t('documents.column.filename'),
			width: '26%',
			value: (record) => record.filename,
			cell: (record) => <span class="ui-cell">
				<b>{record.filename}</b>
				<small class="ui-cell__muted">{timestampLabel(record.createdAt)}</small>
			</span>,
		},
		{
			key: 'ownerModule',
			header: t('documents.column.ownerModule'),
			width: '14%',
			value: (record) => record.ownerModule,
			cell: (record) => <span class="ui-mono">{record.ownerModule}</span>,
		},
		{
			key: 'recordRef',
			header: t('documents.column.recordRef'),
			width: '16%',
			value: (record) => record.recordRef,
			cell: (record) => <span class="ui-mono">{record.recordRef}</span>,
		},
		{
			key: 'contentType',
			header: t('documents.column.contentType'),
			width: '14%',
			value: (record) => record.contentType,
			cell: (record) => <span class="ui-mono">{record.contentType}</span>,
		},
		{
			key: 'bytes',
			header: t('documents.column.bytes'),
			width: '10%',
			numeric: true,
			value: (record) => record.bytes,
			cell: (record) => byteLabel(record.bytes),
		},
		{
			key: 'scan',
			header: t('documents.column.scan'),
			width: '10%',
			value: (record) => record.scan,
			cell: (record) =>
				<Tag tone={scanTone(record.scan)} dot>{scanLabel(record.scan)}</Tag>,
		},
		{
			key: 'uploaderAccountId',
			header: t('documents.column.uploader'),
			width: '10%',
			value: (record) => record.uploaderAccountId,
			cell: (record) => <span class="ui-mono">{record.uploaderAccountId}</span>,
		},
	];
}

export function DocumentsView(props: DocumentsViewProps) @{
	const client = useMemo(() => createDocumentsClientState(), []);
	const [documents] = useValue(client.state.documents);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [ownerFilter, setOwnerFilter] = useValue(
		client.state.ownerModuleFilter,
	);
	const [scanFilter, setScanFilter] = useValue(client.state.scanFilter);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [uploaderOpen, setUploaderOpen] = useValue(client.state.uploaderOpen);
	const [formSession, setFormSession] = useValue(client.state.formSession);
	const [ownerModuleOptions] = useValue(client.state.ownerModulesSeen);
	const [nextCursor] = useValue(client.state.nextCursor);
	const [confirmDeleteId, setConfirmDeleteId] = useValue(
		client.state.confirmDeleteId,
	);
	const [appliedQuery] = useValue(client.state.appliedQuery);
	const [limits, setLimits] = useState<DocumentLimits | null>(null);
	const term = query.trim();
	const filtered = term !== '' || ownerFilter !== '' || scanFilter !== '';
	const pendingDelete =
		documents.find((record) => record.id === confirmDeleteId) ?? null;

	/* `append` continues the open listing; anything else starts a new one, so a
   changed filter can never mix two result sets. The filters travel as an
   argument because a select change and the load it starts happen in one
   render, where the state hook still reads the value before the change. */
	const load = async (
		append: boolean,
		filters: {
			readonly ownerModule: string;
			readonly scan: DocumentScan | '';
			readonly search: string;
		} = { ownerModule: ownerFilter, scan: scanFilter, search: appliedQuery },
	) => {
		setStatus('loading');
		setError('');
		try {
			const page = await loadDocuments({
				ownerModule: filters.ownerModule,
				scan: filters.scan,
				search: filters.search,
				cursor: append ? nextCursor : null,
			});
			client.store.act((transaction) => {
				transaction.set(
					client.state.documents,
					mergeDocumentPage(documents, page.items, append),
				);
				transaction.set(client.state.appliedQuery, filters.search);
				transaction.set(
					client.state.ownerModulesSeen,
					mergeOwnerModules(ownerModuleOptions, page.items),
				);
				transaction.set(client.state.nextCursor, page.page.nextCursor);
				transaction.set(client.state.status, 'idle');
			}, 'documents/loaded');
		} catch (loadError) {
			setError(documentsErrorMessage(loadError, 'documents.error.load'));
			setStatus(
				loadError instanceof DocumentsApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	const refresh = () => load(false);

	useEffect(() => {
		void refresh();
		/* The uploader states the limits the port applies; a screen that could
	   not read them offers the upload anyway and lets the server refuse. */
		void loadDocumentLimits().then(setLimits).catch(() => undefined);
	}, []);

	/* The term is the server's filter, so typing it starts a new listing rather
   than narrowing the page on screen. One listing per pause in the typing, and
   none at all while the rows already answer this term. */
	useEffect(() => {
		if (!searchPending(query, appliedQuery)) return;
		const timer = setTimeout(
			() => void load(false, {
				ownerModule: ownerFilter,
				scan: scanFilter,
				search: term,
			}),
			SEARCH_DEBOUNCE_MS,
		);
		return () => clearTimeout(timer);
	}, [query]);

	const openUploader = () => {
		client.store.act((transaction) => {
			transaction.set(client.state.formSession, formSession + 1);
			transaction.set(client.state.error, '');
			transaction.set(client.state.uploaderOpen, true);
		}, 'documents/upload-open');
	};

	const upload = async (value: DocumentUploadValue) => {
		setStatus('submitting');
		setError('');
		try {
			await uploadDocument(value, props.csrfToken);
			await refresh();
			setUploaderOpen(false);
			toasts.success(t('documents.notice.uploaded', { name: value.file.name }));
		} catch (uploadError) {
			setError(documentsErrorMessage(uploadError, 'documents.error.upload'));
			setStatus('idle');
		}
	};

	/* The platform route streams the decrypted bytes as an attachment, so
   opening it is the download and the link expires on its own. The tab is
   claimed inside this click: one opened after the read URL resolves is a
   pop-up the browser blocks. */
	const download = async (record: DocumentAttachment) => {
		setError('');
		try {
			await runDownload(
				window,
				async () => (await documentReadUrl(record.id, props.csrfToken)).url,
			);
		} catch (readError) {
			setError(
				readError instanceof DownloadBlocked
					? t('documents.error.downloadBlocked')
					: documentsErrorMessage(readError, 'documents.error.readUrl'),
			);
		}
	};

	const remove = async () => {
		const record = pendingDelete;
		setConfirmDeleteId(null);
		if (!record) return;
		setStatus('submitting');
		setError('');
		try {
			await deleteDocument(record.id, props.csrfToken);
			await refresh();
			toasts.success(t('documents.notice.deleted', { name: record.filename }));
		} catch (deleteError) {
			setError(documentsErrorMessage(deleteError, 'documents.error.delete'));
			setStatus('idle');
		}
	};

	const rowActions = (record: DocumentAttachment): readonly TableAction[] => {
		const copy = downloadAction(record);
		return [
			{
				id: 'download',
				label: copy.label,
				icon: 'download',
				disabled: copy.disabled,
				reason: copy.reason,
				onSelect: () => void download(record),
			},
			...(props.canManage && record.status === 'stored'
				? [
						{
							id: 'delete',
							label: t('documents.action.delete'),
							icon: 'x',
							tone: 'danger' as const,
							onSelect: () => setConfirmDeleteId(record.id),
						},
					]
				: []),
		];
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('documents.page.eyebrow')}
			title={t('documents.page.title')}
			description={t('documents.page.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh()}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('documents.common.refreshing')
					: t('documents.common.refresh')}
			</Button>
			@if (props.canManage) {
				<Button
					size="sm"
					variant="primary"
					disabled={status === 'denied'}
					onClick={openUploader}
				>
					<Icon name="plus" size={14} />
					{t('documents.upload.action.open')}
				</Button>
			}
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('documents.common.accessDenied')}>{t(
					'documents.denied',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (error && !uploaderOpen) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('documents.table.title')}
					count={nextCursor === null
						? t('documents.table.count', { count: documents.length })
						: t('documents.table.countMore', { count: documents.length })}
					search={<SearchField
						value={query}
						placeholder={t('documents.search.placeholder')}
						label={t('documents.search.label')}
						onInput={setQuery}
					/>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={(ownerFilter === '' ? 0 : 1) +
							(scanFilter === '' ? 0 : 1)}
						label={t('documents.common.filters')}
					>
						<Select
							id="documents-owner-module"
							label={t('documents.filter.ownerModule')}
							value={ownerFilter}
							options={[
								{ value: '', label: t('documents.filter.allOwnerModules') },
								...ownerModuleOptions.map(
									(value) => ({
										value,
										label: value,
									}),
								),
							]}
							onChange={(value) => {
								setOwnerFilter(value);
								void load(false, {
									ownerModule: value,
									scan: scanFilter,
									search: term,
								});
							}}
						/>
						<Select
							id="documents-scan"
							label={t('documents.filter.scan')}
							value={scanFilter}
							options={[
								{ value: '', label: t('documents.filter.allScans') },
								...DOCUMENT_SCANS.map(
									(value) => ({
										value,
										label: scanLabel(value),
									}),
								),
							]}
							onChange={(value) => {
								const scan = value as DocumentScan | '';
								setScanFilter(scan);
								void load(false, {
									ownerModule: ownerFilter,
									scan,
									search: term,
								});
							}}
						/>
					</Filters>}
					caption={t('documents.table.caption')}
					columns={columns()}
					rows={documents}
					rowKey={(record) => record.id}
					sorting
					after={nextCursor === null
						? null
						: <div class="ui-form__actions">
								<Button
									size="sm"
									disabled={status === 'loading'}
									onClick={() => void load(true)}
								>{t('documents.action.more')}</Button>
							</div>}
					status={status === 'loading' && documents.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('documents.table.loading')}
					filtered={filtered}
					empty={tableEmpty(status, {
						icon: 'file-text',
						title: t('documents.empty.title'),
						hint: t('documents.empty.hint'),
					})}
					emptyFiltered={tableEmpty(status, {
						icon: 'search',
						title: t('documents.emptyFiltered.title'),
						hint: t('documents.emptyFiltered.hint'),
					})}
					actions={rowActions}
					actionsLabel={t('documents.common.actions')}
					actionsWidth="220px"
					noteIcon="shield"
					note={t('documents.table.note')}
				/>
			</>
		}
		<Drawer
			open={uploaderOpen}
			title={t('documents.upload.drawer.title')}
			subtitle={t('documents.upload.drawer.subtitle')}
			width="md"
			onClose={() => setUploaderOpen(false)}
		>
			<DocumentUploader
				key={'documents-uploader-' + formSession}
				busy={status === 'submitting'}
				error={uploaderOpen ? error : ''}
				limits={limits}
				onCancel={() => setUploaderOpen(false)}
				onSubmit={(value) => void upload(value)}
			/>
		</Drawer>
		<ConfirmDialog
			open={confirmDeleteId !== null}
			title={t('documents.delete.title')}
			confirmLabel={t('documents.action.delete')}
			busy={status === 'submitting'}
			onConfirm={() => void remove()}
			onCancel={() => setConfirmDeleteId(null)}
		>{t('documents.delete.description', {
			name: pendingDelete?.filename ?? '',
		})}</ConfirmDialog>
		<ToastHost
			label={t('documents.common.messages')}
			closeLabel={t('documents.common.close')}
		/>
	</div>
}
