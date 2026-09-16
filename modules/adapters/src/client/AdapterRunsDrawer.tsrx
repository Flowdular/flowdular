import { useEffect, useState } from 'octane';
import {
	Alert,
	Button,
	CellCode,
	CellNumber,
	CellStack,
	CellTag,
	CellText,
	CellTime,
	Drawer,
	EmptyState,
	Table,
	type TableAction,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client/i18n';
import type { AdapterRunRow, AdapterRunView } from '../domain/types.ts';
import {
	adaptersErrorMessage,
	cancelRun,
	loadRunRows,
	loadRuns,
	resumeRun,
	type AdapterListItem,
} from './api.ts';
import {
	codeLabel,
	outcomeLabel,
	outcomeTone,
	statusLabel,
	statusTone,
	timestampLabel,
} from './presentation.ts';

export interface AdapterRunsDrawerProps {
	readonly open: boolean;
	readonly adapter: AdapterListItem | null;
	readonly csrfToken: string;
	readonly canManage: boolean;
	readonly onClose: () => void;
}

function runColumns(
	direction: AdapterRunView['direction'],
): readonly TableColumn<AdapterRunView>[] {
	return [
		{
			key: 'queuedAt',
			header: t('adapters.runs.column.queuedAt'),
			width: '170px',
			cell: (run) =>
				<CellStack
					primary={<CellTime value={run.queuedAt} />}
					secondary={t('adapters.trigger.' + run.trigger)}
				/>,
		},
		{
			key: 'status',
			header: t('adapters.runs.column.status'),
			width: 'auto',
			cell: (run) =>
				<CellStack
					primary={<CellTag
						tone={statusTone(run.status)}
						dot
						label={statusLabel(run.status)}
					/>}
					secondary={codeLabel(run.errorCode)}
				/>,
		},
		{
			key: 'pages',
			header: t('adapters.runs.column.pages'),
			width: '100px',
			numeric: true,
			priority: 3,
			cell: (run) => <CellNumber value={run.pages} />,
		},
		{
			key: 'read',
			header: t('adapters.runs.column.read'),
			width: '100px',
			numeric: true,
			priority: 2,
			cell: (run) => <CellNumber value={run.rowsRead} />,
		},
		{
			key: 'created',
			header: direction === 'sink'
				? t('adapters.runs.column.pushed')
				: t('adapters.runs.column.created'),
			width: '100px',
			numeric: true,
			priority: 2,
			cell: (run) => <CellNumber value={run.rowsCreated} />,
		},
		{
			key: 'updated',
			header: t('adapters.runs.column.updated'),
			width: '100px',
			numeric: true,
			priority: 3,
			cell: (run) => <CellNumber value={run.rowsUpdated} />,
		},
		{
			key: 'skipped',
			header: t('adapters.runs.column.skipped'),
			width: '100px',
			numeric: true,
			priority: 3,
			cell: (run) => <CellNumber value={run.rowsSkipped} />,
		},
		{
			key: 'failed',
			header: t('adapters.runs.column.failed'),
			width: '100px',
			numeric: true,
			priority: 2,
			cell: (run) => <CellNumber value={run.rowsFailed} />,
		},
	];
}

function rowColumns(): readonly TableColumn<AdapterRunRow>[] {
	return [
		{
			key: 'rowIndex',
			header: t('adapters.rows.column.index'),
			width: '96px',
			numeric: true,
			cell: (row) => <CellNumber value={row.rowIndex} />,
		},
		{
			key: 'naturalKey',
			header: t('adapters.rows.column.naturalKey'),
			width: '170px',
			priority: 2,
			cell: (row) => row.naturalKey
				? <CellCode value={row.naturalKey} />
				: null,
		},
		{
			key: 'outcome',
			header: t('adapters.rows.column.outcome'),
			width: '130px',
			cell: (row) =>
				<CellTag
					tone={outcomeTone(row.outcome)}
					dot
					label={outcomeLabel(row.outcome)}
				/>,
		},
		{
			key: 'code',
			header: t('adapters.rows.column.code'),
			width: 'auto',
			cell: (row) => row.errorCode
				? <CellText value={codeLabel(row.errorCode)} wrap />
				: null,
		},
		{
			key: 'message',
			header: t('adapters.rows.column.message'),
			width: '150px',
			priority: 2,
			cell: (row) => row.message ? <CellText value={row.message} mono /> : null,
		},
	];
}

export function AdapterRunsDrawer(props: AdapterRunsDrawerProps) @{
	const adapter = props.adapter;
	const [runs, setRuns] = useState<readonly AdapterRunView[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const [openRun, setOpenRun] = useState<AdapterRunView | null>(null);
	const [rows, setRows] = useState<readonly AdapterRunRow[]>([]);
	const [rowsCursor, setRowsCursor] = useState<string | null>(null);
	const [rowsLoading, setRowsLoading] = useState(false);
	const [busy, setBusy] = useState(false);

	const refresh = async () => {
		if (!adapter) return;
		setLoading(true);
		setError('');
		try {
			const page = await loadRuns(adapter.id);
			setRuns(page.items);
			setCursor(page.page.nextCursor);
		} catch (failure) {
			setError(adaptersErrorMessage(failure, 'adapters.error.load'));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		if (!props.open || !adapter) return;
		setRuns([]);
		setCursor(null);
		setOpenRun(null);
		setRows([]);
		void refresh();
	}, [props.open, adapter?.id]);

	const more = async () => {
		if (!adapter || cursor === null) return;
		setLoading(true);
		try {
			const page = await loadRuns(adapter.id, cursor);
			setRuns([...runs, ...page.items]);
			setCursor(page.page.nextCursor);
		} catch (failure) {
			setError(adaptersErrorMessage(failure, 'adapters.error.load'));
		} finally {
			setLoading(false);
		}
	};

	const openRows = async (run: AdapterRunView, after: string | null) => {
		setOpenRun(run);
		setRowsLoading(true);
		try {
			const page = await loadRunRows(run.id, after);
			setRows(after === null ? page.items : [...rows, ...page.items]);
			setRowsCursor(page.page.nextCursor);
		} catch (failure) {
			setError(adaptersErrorMessage(failure, 'adapters.error.load'));
		} finally {
			setRowsLoading(false);
		}
	};

	const act = async (work: () => Promise<unknown>, fallbackKey: string) => {
		setBusy(true);
		setError('');
		try {
			await work();
			await refresh();
		} catch (failure) {
			setError(adaptersErrorMessage(failure, fallbackKey));
		} finally {
			setBusy(false);
		}
	};

	const latest = runs[0];
	const actions = (run: AdapterRunView): readonly TableAction[] => [
		{
			id: 'rows',
			label: t('adapters.action.rows'),
			icon: 'file-text',
			onSelect: () => void openRows(run, null),
		},
		...(props.canManage && run.id === latest?.id &&
		(run.status === 'failed' || run.status === 'cancelled') &&
		run.cursor !== null
			? [
					{
						id: 'resume',
						label: t('adapters.action.resume'),
						icon: 'play',
						disabled: busy,
						onSelect: () => void act(
							() => resumeRun(run.id, props.csrfToken),
							'adapters.error.resume',
						),
					},
				]
			: []),
		...(props.canManage && (run.status === 'queued' || run.status === 'running')
			? [
					{
						id: 'cancel',
						label: t('adapters.action.cancel'),
						icon: 'x',
						tone: 'danger' as const,
						disabled: busy,
						onSelect: () => void act(
							() => cancelRun(run.id, props.csrfToken),
							'adapters.error.cancel',
						),
					},
				]
			: []),
	];

	<Drawer
		open={props.open && adapter !== null}
		title={t('adapters.runs.title')}
		subtitle={adapter ? adapter.label : ''}
		width="lg"
		onClose={props.onClose}
	>
		<div class="ui-drawer__body">
			@if (error !== '') {
				<Alert>{error}</Alert>
			}
			<div class="ui-form__actions">
				<Button size="sm" disabled={loading} onClick={() => void refresh()}>
					{loading
						? t('adapters.common.refreshing')
						: t('adapters.common.refresh')}
				</Button>
			</div>
			<Table
				caption={t('adapters.runs.caption')}
				columns={runColumns(adapter?.direction ?? 'source')}
				rows={runs}
				rowKey={(run) => run.id}
				status={loading && runs.length === 0 ? 'loading' : 'idle'}
				loadingLabel={t('adapters.runs.loading')}
				empty={{
					icon: 'activity',
					title: t('adapters.runs.empty.title'),
					hint: t('adapters.runs.empty.hint'),
				}}
				actions={actions}
				actionsLabel={t('adapters.common.actions')}
				actionsWidth="220px"
			/>
			@if (cursor !== null) {
				<div class="ui-form__actions">
					<Button size="sm" disabled={loading} onClick={() => void more()}>{t(
						'adapters.common.loadMore',
					)}</Button>
				</div>
			}
			@if (openRun) {
				<section class="ui-form__section">
					<div class="ui-form__section-head">
						<b>{t('adapters.rows.title')}</b>
						<small>{timestampLabel(openRun.queuedAt)}</small>
					</div>
					@if (rows.length === 0 && !rowsLoading) {
						<EmptyState icon="check" title={t('adapters.rows.empty.title')}>{t(
							'adapters.rows.empty.hint',
						)}</EmptyState>
					} @else {
						<Table
							caption={t('adapters.rows.caption')}
							columns={rowColumns()}
							rows={rows}
							rowKey={(row) => String(row.rowIndex)}
							status={rowsLoading && rows.length === 0 ? 'loading' : 'idle'}
							loadingLabel={t('adapters.rows.loading')}
							empty={{
								icon: 'check',
								title: t('adapters.rows.empty.title'),
								hint: t('adapters.rows.empty.hint'),
							}}
						/>
					}
					@if (rowsCursor !== null) {
						<div class="ui-form__actions">
							<Button
								size="sm"
								disabled={rowsLoading}
								onClick={() => void openRows(openRun, rowsCursor)}
							>{t('adapters.common.loadMore')}</Button>
						</div>
					}
				</section>
			}
		</div>
	</Drawer>
}
