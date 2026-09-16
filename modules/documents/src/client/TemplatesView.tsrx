import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	CellCode,
	CellMuted,
	CellStack,
	CellTag,
	CellText,
	CellTime,
	EmptyState,
	Icon,
	PageHeader,
	SearchField,
	TableCard,
	ToastHost,
	type TableAction,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import { DocumentsApiError, documentsErrorMessage } from './api.ts';
import { tableEmpty } from './presentation.ts';
import { TemplateEditorDrawer } from './TemplateEditorDrawer.tsrx';
import { loadTemplates, type TemplateListItem } from './templates-api.ts';
import {
	originLabel,
	originTone,
	versionLabel,
} from './templates-presentation.ts';
import {
	createTemplatesClientState,
	matchingTemplates,
} from './templates-state.ts';

export interface TemplatesViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

function columns(): readonly TableColumn<TemplateListItem>[] {
	return [
		{
			key: 'title',
			header: t('documents.templates.column.title'),
			width: 'auto',
			value: (template) => template.title,
			cell: (template) =>
				<CellStack
					primary={template.title}
					secondary={template.key}
					secondaryMono
				/>,
		},
		{
			key: 'ownerModule',
			header: t('documents.templates.column.module'),
			width: '160px',
			priority: 2,
			value: (template) => template.ownerModule,
			cell: (template) => <CellText value={template.ownerModule} mono />,
		},
		{
			key: 'key',
			header: t('documents.templates.column.key'),
			width: '200px',
			priority: 3,
			value: (template) => template.key,
			cell: (template) => <CellCode value={template.key} max={28} />,
		},
		{
			key: 'format',
			header: t('documents.templates.column.format'),
			width: '100px',
			value: (template) => template.format,
			cell: (template) =>
				<CellTag
					label={t('documents.templates.format.' + template.format)}
					mono
				/>,
		},
		{
			key: 'version',
			header: t('documents.templates.column.version'),
			width: '140px',
			value: (template) => template.version ?? 0,
			cell: (template) => template.version === null
				? <CellMuted
						title={t('documents.templates.version.defaultHint')}
					>{versionLabel(null)}</CellMuted>
				: <CellStack
						primary={versionLabel(template.version)}
						secondary={<CellTag
							tone={originTone(template.origin)}
							label={originLabel(template.origin)}
						/>}
					/>,
		},
		{
			key: 'updatedAt',
			header: t('documents.templates.column.updated'),
			width: '170px',
			priority: 2,
			value: (template) => template.updatedAt ?? 0,
			cell: (template) => template.updatedAt === null
				? <CellMuted>{t('documents.templates.never')}</CellMuted>
				: <CellTime value={template.updatedAt} />,
		},
	];
}

export function TemplatesView(props: TemplatesViewProps) @{
	const client = useMemo(() => createTemplatesClientState(), []);
	const [templates, setTemplates] = useValue(client.state.templates);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [openKey, setOpenKey] = useValue(client.state.openKey);
	const shown = matchingTemplates(templates, query);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const loaded = await loadTemplates();
			client.store.act((transaction) => {
				transaction.set(client.state.templates, loaded);
				transaction.set(client.state.status, 'idle');
			}, 'documents/templates-loaded');
		} catch (loadError) {
			setError(
				documentsErrorMessage(loadError, 'documents.templates.error.load'),
			);
			setStatus(
				loadError instanceof DocumentsApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const rowActions = (template: TemplateListItem): readonly TableAction[] => [
		{
			id: 'open',
			label: props.canManage
				? t('documents.templates.action.edit')
				: t('documents.templates.action.open'),
			icon: 'file-text',
			onSelect: () => setOpenKey(template.key),
		},
	];

	<div class="ui-view">
		<PageHeader
			eyebrow={t('documents.templates.page.eyebrow')}
			title={t('documents.templates.page.title')}
			description={t('documents.templates.page.description')}
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
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('documents.common.accessDenied')}>{t(
					'documents.templates.denied',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (error) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('documents.templates.table.title')}
					count={t('documents.templates.table.count', { count: shown.length })}
					search={<SearchField
						value={query}
						placeholder={t('documents.templates.search.placeholder')}
						label={t('documents.templates.search.label')}
						onInput={setQuery}
					/>}
					caption={t('documents.templates.table.caption')}
					columns={columns()}
					rows={shown}
					rowKey={(template) => template.key}
					sorting
					onSelect={(template) => setOpenKey(template.key)}
					status={status === 'loading' && templates.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('documents.templates.table.loading')}
					filtered={query.trim() !== ''}
					empty={tableEmpty(status, {
						icon: 'file-text',
						title: t('documents.templates.empty.title'),
						hint: t('documents.templates.empty.hint'),
					})}
					emptyFiltered={tableEmpty(status, {
						icon: 'search',
						title: t('documents.templates.emptyFiltered.title'),
						hint: t('documents.templates.emptyFiltered.hint'),
					})}
					actions={rowActions}
					actionsLabel={t('documents.common.actions')}
					actionsWidth="120px"
					noteIcon="shield"
					note={props.canManage
						? t('documents.templates.table.noteManage')
						: t('documents.templates.table.noteRead')}
				/>
			</>
		}
		<TemplateEditorDrawer
			templateKey={openKey}
			csrfToken={props.csrfToken}
			canManage={props.canManage}
			onClose={() => setOpenKey(null)}
			onChanged={() => void refresh()}
		/>
		<ToastHost
			label={t('documents.common.messages')}
			closeLabel={t('documents.common.close')}
		/>
	</div>
}
