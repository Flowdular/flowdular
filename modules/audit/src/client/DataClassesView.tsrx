import { useEffect, useMemo, useState } from 'octane';
import {
	Alert,
	Button,
	Drawer,
	EmptyState,
	Filters,
	FormField,
	Icon,
	PageHeader,
	Pagination,
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
import { DATA_CLASS_LIMITS } from '../domain/data-classes.ts';
import {
	RETENTION_MODES,
	type AuditDataClass,
	type RetentionMode,
} from '../domain/types.ts';
import {
	AuditApiError,
	auditErrorMessage,
	loadRegistry,
	setRetention,
} from './api.ts';
import {
	booleanLabel,
	defaultRetentionLabel,
	retentionLabel,
	timestampLabel,
} from './presentation.ts';
import { createDataClassesClientState } from './state.ts';

export interface DataClassesViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

const PAGE_SIZES = [10, 25, 50, 100];

function columns(): readonly TableColumn<AuditDataClass>[] {
	return [
		{
			key: 'classId',
			header: t('audit.dataClasses.column.classId'),
			width: '22%',
			value: (record) => record.classId,
			cell: (record) => <span class="ui-cell">
				<b>{record.label}</b>
				<small class="ui-cell__muted ui-mono">{record.classId}</small>
			</span>,
		},
		{
			key: 'moduleId',
			header: t('audit.dataClasses.column.moduleId'),
			width: '14%',
			value: (record) => record.moduleId,
			cell: (record) => <span class="ui-mono">{record.moduleId}</span>,
		},
		{
			key: 'retentionDays',
			header: t('audit.dataClasses.column.retention'),
			width: '16%',
			value: (record) => record.effectiveRetentionDays ?? -1,
			cell: (record) => retentionLabel(record),
		},
		{
			key: 'defaultRetentionDays',
			header: t('audit.dataClasses.column.defaultRetention'),
			width: '14%',
			value: (record) => record.defaultRetentionDays ?? -1,
			cell: (record) => defaultRetentionLabel(record),
		},
		{
			key: 'exportable',
			header: t('audit.dataClasses.column.exportable'),
			width: '12%',
			value: (record) => booleanLabel(record.exportable),
			cell: (record) =>
				<Tag tone={record.exportable ? 'success' : 'neutral'}>{booleanLabel(
					record.exportable,
				)}</Tag>,
		},
		{
			key: 'lastSweptAt',
			header: t('audit.dataClasses.column.lastSweptAt'),
			width: '16%',
			value: (record) => record.lastSweptAt ?? 0,
			cell: (record) => timestampLabel(record.lastSweptAt),
		},
	];
}

export function DataClassesView(props: DataClassesViewProps) @{
	const client = useMemo(() => createDataClassesClientState(), []);
	const [classes] = useValue(client.state.classes);
	const [emptyModules] = useValue(client.state.emptyModules);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [moduleFilter, setModuleFilter] = useValue(client.state.moduleFilter);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [editing, setEditing] = useValue(client.state.editing);
	const [formMode, setFormMode] = useValue(client.state.formMode);
	const [formDays, setFormDays] = useValue(client.state.formDays);
	const [formError, setFormError] = useValue(client.state.formError);
	const [pageIndex, setPageIndex] = useState(0);
	const [pageSize, setPageSize] = useState(25);
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const visible = classes.filter(
		(record) =>
			(moduleFilter === '' || record.moduleId === moduleFilter) &&
				(term === '' ||
					record.classId.toLocaleLowerCase(locale).includes(term) ||
					record.label.toLocaleLowerCase(locale).includes(term)),
	);
	const filterCount =
		moduleFilter === '' ? 0 : 1;
	const filtered = filterCount > 0 || term !== '';
	const moduleOptions = [
		...new Set(classes.map((record) => record.moduleId)),
	].sort().map((id) => ({ value: id, label: id }));

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const modules = await loadRegistry();
			client.store.act((transaction) => {
				transaction.set(
					client.state.classes,
					modules.flatMap((entry) => entry.classes),
				);
				transaction.set(
					client.state.emptyModules,
					modules.filter((entry) => entry.classes.length === 0).map(
						(entry) => entry.moduleId,
					),
				);
				transaction.set(client.state.status, 'idle');
			}, 'audit/registry-loaded');
		} catch (loadError) {
			setError(auditErrorMessage(loadError, 'audit.dataClasses.error.load'));
			setStatus(
				loadError instanceof AuditApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const openEditor = (record: AuditDataClass) => {
		client.store.act((transaction) => {
			transaction.set(client.state.editing, record);
			transaction.set(client.state.formMode, record.retentionMode);
			transaction.set(
				client.state.formDays,
				record.retentionDays === null ? '' : String(record.retentionDays),
			);
			transaction.set(client.state.formError, '');
		}, 'audit/retention-editor-opened');
	};

	const submit = async () => {
		const record = editing;
		if (!record) return;
		const days =
			formMode === 'days' ? Number(formDays) : null;
		if (
			formMode === 'days' &&
				(!Number.isSafeInteger(days) || (days ?? 0) < 1 ||
					(days ?? 0) > DATA_CLASS_LIMITS.retentionDays)
		) {
			setFormError(t('audit.dataClasses.form.daysInvalid'));
			return;
		}
		setStatus('submitting');
		setFormError('');
		try {
			await setRetention(
				{ classId: record.classId, mode: formMode, days },
				props.csrfToken,
			);
			setEditing(null);
			await refresh();
			toasts.success(t('audit.dataClasses.notice.saved'));
		} catch (saveError) {
			setFormError(
				auditErrorMessage(saveError, 'audit.dataClasses.error.save'),
			);
			setStatus('idle');
		}
	};

	const rowActions = (record: AuditDataClass): readonly TableAction[] =>
		props.canManage
			? [
					{
						id: 'set-retention',
						label: t('audit.dataClasses.action.setRetention'),
						icon: 'settings',
						onSelect: () => openEditor(record),
					},
				]
			: [];

	<div class="ui-view">
		<PageHeader
			eyebrow={t('audit.common.administration')}
			title={t('audit.dataClasses.title')}
			description={t('audit.dataClasses.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh()}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('audit.common.refreshing')
					: t('audit.common.refresh')}
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('audit.common.accessDenied')}>{t(
					'audit.dataClasses.denied',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (error) {
					<Alert>{error}</Alert>
				}
				@if (emptyModules.length > 0) {
					<Alert tone="info">{t('audit.dataClasses.holdNothing', {
						modules: emptyModules.join(', '),
					})}</Alert>
				}
				<TableCard
					title={t('audit.dataClasses.table.title')}
					count={t('audit.dataClasses.table.count', { count: visible.length })}
					search={<SearchField
						value={query}
						placeholder={t('audit.dataClasses.search.placeholder')}
						label={t('audit.dataClasses.search.label')}
						onInput={(value) => {
							setQuery(value);
							setPageIndex(0);
						}}
					/>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={filterCount}
						label={t('audit.common.filters')}
					>
						<Select
							id="audit-data-classes-module"
							label={t('audit.dataClasses.filter.module')}
							value={moduleFilter}
							options={[
								{
									value: '',
									label: t('audit.dataClasses.filter.allModules'),
								},
								...moduleOptions,
							]}
							onChange={(value) => {
								setModuleFilter(value);
								setPageIndex(0);
							}}
						/>
					</Filters>}
					caption={t('audit.dataClasses.table.caption')}
					columns={columns()}
					rows={visible}
					rowKey={(record) => record.classId}
					sorting
					onSortingChange={() => setPageIndex(0)}
					pagination={{ pageIndex, pageSize, onPageChange: setPageIndex }}
					after={<Pagination
						pageIndex={pageIndex}
						pageSize={pageSize}
						totalRows={visible.length}
						pageSizes={PAGE_SIZES}
						onPageChange={setPageIndex}
						onPageSizeChange={(size) => {
							setPageSize(size);
							setPageIndex(0);
						}}
						label={t('audit.pagination.label')}
						previousLabel={t('audit.pagination.previous')}
						nextLabel={t('audit.pagination.next')}
						pageSizeLabel={t('audit.pagination.size')}
						summary={(range) => t('audit.pagination.summary', {
							page: range.pageIndex + 1,
							pages: range.pageCount,
							from: range.from,
							to: range.to,
							total: range.totalRows,
						})}
					/>}
					status={status === 'loading' && classes.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('audit.dataClasses.table.loading')}
					filtered={filtered}
					empty={{
						icon: 'shield',
						title: t('audit.dataClasses.empty.title'),
						hint: t('audit.dataClasses.empty.hint'),
					}}
					emptyFiltered={{
						icon: 'search',
						title: t('audit.dataClasses.emptyFiltered.title'),
						hint: t('audit.dataClasses.emptyFiltered.hint'),
					}}
					actions={rowActions}
					actionsLabel={t('audit.common.actions')}
					noteIcon="shield"
					note={t('audit.dataClasses.note')}
				/>
			</>
		}
		<Drawer
			open={editing !== null}
			title={t('audit.dataClasses.form.title')}
			subtitle={editing?.classId ?? ''}
			onClose={() => setEditing(null)}
		>
			<form
				class="ui-drawer__form"
				onSubmit={(event: Event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<div class="ui-drawer__body">
					@if (formError) {
						<Alert>{formError}</Alert>
					}
					<div class="ui-form">
						<Select
							id="audit-retention-mode"
							label={t('audit.dataClasses.form.mode')}
							value={formMode}
							options={RETENTION_MODES.map(
								(mode) => ({
									value: mode,
									label: t(`audit.retention.mode.${mode}`),
								}),
							)}
							disabled={editing !== null && !editing.sweepable}
							help={editing !== null && !editing.sweepable
								? t('audit.dataClasses.form.notSweepable')
								: t('audit.dataClasses.form.modeHelp')}
							autoFocus
							onChange={(value) => setFormMode(value as RetentionMode)}
						/>
						@if (formMode === 'days') {
							<FormField
								label={t('audit.dataClasses.form.days')}
								required
								help={t('audit.dataClasses.form.daysHelp')}
							>
								<input
									class="ui-input"
									type="number"
									min="1"
									max={String(DATA_CLASS_LIMITS.retentionDays)}
									value={formDays}
									onInput={(event: Event) => setFormDays(
										(event.target as HTMLInputElement).value,
									)}
								/>
							</FormField>
						}
					</div>
				</div>
				<div class="ui-drawer__foot">
					<small>{t('audit.dataClasses.form.constraint')}</small>
					<div class="ui-form__actions">
						<Button type="button" onClick={() => setEditing(null)}>{t(
							'audit.common.close',
						)}</Button>
						<Button
							variant="primary"
							type="submit"
							disabled={status === 'submitting' ||
								editing !== null && !editing.sweepable && formMode !== 'none'}
						>
							{status === 'submitting'
								? t('audit.common.saving')
								: t('audit.dataClasses.action.save')}
						</Button>
					</div>
				</div>
			</form>
		</Drawer>
		<ToastHost
			label={t('audit.common.messages')}
			closeLabel={t('audit.common.close')}
		/>
	</div>
}
