import {
	Alert,
	Button,
	EmptyState,
	Kpi,
	Table,
	Tag,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client/i18n';
import type { ImportJobView, ImportJobRow } from '../domain/types.ts';
import {
	countLabel,
	modeLabel,
	outcomeLabel,
	outcomeTone,
	reasonLabel,
	statusLabel,
	statusTone,
	timestampLabel,
} from './presentation.ts';

export interface ImportJobDrawerProps {
	readonly job: ImportJobView | null;
	readonly rows: readonly ImportJobRow[];
	readonly hasMore: boolean;
	readonly loading: boolean;
	readonly busy: boolean;
	readonly canManage: boolean;
	readonly error: string;
	readonly onLoadMore: () => void;
	readonly onContinue: (validOnly: boolean) => void;
	readonly onCancel: () => void;
}

function columns(): readonly TableColumn<ImportJobRow>[] {
	return [
		{
			key: 'rowNumber',
			header: t('import.rows.column.row'),
			width: '12%',
			numeric: true,
			value: (record) => record.rowNumber,
			cell: (record) => <span class="num">{record.rowNumber}</span>,
		},
		{
			key: 'outcome',
			header: t('import.rows.column.outcome'),
			width: '20%',
			value: (record) => record.outcome,
			cell: (record) =>
				<Tag tone={outcomeTone(record.outcome)} dot>{outcomeLabel(
					record.outcome,
				)}</Tag>,
		},
		{
			key: 'field',
			header: t('import.rows.column.field'),
			width: '20%',
			value: (record) => record.field ?? '',
			cell: (record) => <span class="ui-mono">{record.field ?? ''}</span>,
		},
		{
			key: 'reason',
			header: t('import.rows.column.reason'),
			width: '28%',
			value: (record) => record.reason ?? '',
			cell: (record) => reasonLabel(record.reason),
		},
		{
			key: 'recordRef',
			header: t('import.rows.column.recordRef'),
			width: '20%',
			value: (record) => record.recordRef ?? '',
			cell: (record) => <span class="ui-mono">{record.recordRef ?? ''}</span>,
		},
	];
}

export function ImportJobDrawer(props: ImportJobDrawerProps) @{
	const job = props.job;

	<div class="ui-drawer__body">
		@if (!job) {
			<EmptyState icon="file-text" title={t('import.job.loading')}>{t(
				'import.job.loadingHint',
			)}</EmptyState>
		} @else {
			<>
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
				<div class="ui-kpi-grid">
					<Kpi
						label={t('import.job.totalRows')}
						value={countLabel(job.totalRows)}
					/>
					<Kpi
						label={t('import.job.validRows')}
						value={countLabel(job.validRows)}
					/>
					<Kpi
						label={t('import.job.writtenRows')}
						value={countLabel(job.writtenRows)}
					/>
					<Kpi
						label={t('import.job.failedRows')}
						value={countLabel(job.failedRows)}
					/>
				</div>
				<div class="ui-form">
					<div class="ui-form__row">
						<div class="ui-field">
							<span class="ui-label">{t('import.column.target')}</span>
							<span class="ui-mono">{job.target}</span>
						</div>
						<div class="ui-field">
							<span class="ui-label">{t('import.column.status')}</span>
							<span>
								<Tag tone={statusTone(job.status)} dot>{statusLabel(
									job.status,
								)}</Tag>
							</span>
						</div>
					</div>
					<div class="ui-form__row">
						<div class="ui-field">
							<span class="ui-label">{t('import.column.mode')}</span>
							<span>{modeLabel(job.mode)}</span>
						</div>
						<div class="ui-field">
							<span class="ui-label">{t('import.column.dryRun')}</span>
							<span>
								{job.dryRun ? t('import.common.yes') : t('import.common.no')}
							</span>
						</div>
					</div>
					<div class="ui-form__row">
						<div class="ui-field">
							<span class="ui-label">{t('import.column.documentId')}</span>
							<span class="ui-mono">{job.documentId}</span>
						</div>
						<div class="ui-field">
							<span class="ui-label">{t('import.column.startedAt')}</span>
							<span>{timestampLabel(job.startedAt)}</span>
						</div>
					</div>
					<div class="ui-form__row">
						<div class="ui-field">
							<span class="ui-label">{t('import.column.completedAt')}</span>
							<span>
								{job.completedAt === null
									? t('import.common.pending')
									: timestampLabel(job.completedAt)}
							</span>
						</div>
						@if (job.failureCode) {
							<div class="ui-field">
								<span class="ui-label">{t('import.job.failureCode')}</span>
								<span class="ui-mono">{reasonLabel(job.failureCode)}</span>
							</div>
						}
					</div>
				</div>
				@if (props.canManage && job.status === 'validated') {
					<div class="ui-form__section">
						<div class="ui-form__section-head">
							<b>{t('import.job.decide')}</b>
							<small>
								{job.validRows === job.totalRows
									? t('import.job.decideClean')
									: t('import.job.decideMixed', {
											valid: countLabel(job.validRows),
											total: countLabel(job.totalRows),
										})}
							</small>
						</div>
						<div class="ui-form__actions">
							<Button
								variant="primary"
								disabled={props.busy}
								onClick={() => props.onContinue(
									job.validRows !== job.totalRows,
								)}
							>{t('import.action.continue')}</Button>
							<Button
								variant="danger"
								disabled={props.busy}
								onClick={props.onCancel}
							>{t('import.action.cancel')}</Button>
						</div>
					</div>
				}
				@if (props.rows.length === 0 && !props.loading) {
					<EmptyState icon="check" title={t('import.rows.empty.title')}>{t(
						'import.rows.empty.hint',
					)}</EmptyState>
				} @else {
					<>
						<Table
							caption={t('import.rows.caption')}
							columns={columns()}
							rows={props.rows}
							rowKey={(record) => record.id}
							status={props.loading && props.rows.length === 0
								? 'loading'
								: 'idle'}
							loadingLabel={t('import.rows.loading')}
							empty={{
								icon: 'check',
								title: t('import.rows.empty.title'),
								hint: t('import.rows.empty.hint'),
							}}
						/>
						@if (props.hasMore) {
							<div class="ui-form__actions">
								<Button disabled={props.loading} onClick={props.onLoadMore}>
									{props.loading
										? t('import.rows.loading')
										: t('import.rows.loadMore')}
								</Button>
							</div>
						}
					</>
				}
			</>
		}
	</div>
}
