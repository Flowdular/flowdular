import {
	Alert,
	CellNumber,
	CellStack,
	CellTag,
	CellTime,
	Drawer,
	Table,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import type { ResearchAttemptRow, ResearchQueryRow } from './api.ts';
import {
	adapterLabel,
	attemptOutcomeLabel,
	attemptOutcomeTone,
	durationLabel,
	errorCodeLabel,
} from './presentation.ts';

export interface QueryAttemptsDrawerProps {
	readonly query: ResearchQueryRow | null;
	readonly attempts: readonly ResearchAttemptRow[];
	readonly status: 'idle' | 'loading' | 'error';
	readonly error: string;
	readonly onClose: () => void;
}

function columns(): readonly TableColumn<ResearchAttemptRow>[] {
	return [
		{
			key: 'adapter',
			header: t('research.attempts.column.adapter'),
			width: 'auto',
			value: (row) => row.adapter,
			cell: (row) =>
				<CellStack
					primary={adapterLabel(row.adapter)}
					secondary={<CellTime value={row.createdAt} />}
				/>,
		},
		{
			key: 'attempt',
			header: t('research.attempts.column.attempt'),
			width: '100px',
			numeric: true,
			priority: 3,
			value: (row) => row.attempt,
			cell: (row) => row.attempt === 0
				? null
				: <CellNumber value={row.attempt} />,
		},
		{
			key: 'outcome',
			header: t('research.attempts.column.outcome'),
			width: '130px',
			value: (row) => row.outcome,
			cell: (row) =>
				<CellTag
					tone={attemptOutcomeTone(row.outcome)}
					dot
					label={attemptOutcomeLabel(row.outcome)}
				/>,
		},
		{
			key: 'errorCode',
			header: t('research.attempts.column.error'),
			width: '220px',
			priority: 2,
			value: (row) => row.errorCode ?? '',
			cell: (row) => row.errorCode === null
				? null
				: <CellStack
						primary={errorCodeLabel(row.errorCode)}
						secondary={row.errorCode}
						secondaryMono
					/>,
		},
		{
			key: 'durationMs',
			header: t('research.attempts.column.duration'),
			width: '110px',
			numeric: true,
			priority: 3,
			value: (row) => row.durationMs,
			cell: (row) => <CellNumber value={durationLabel(row.durationMs)} />,
		},
	];
}

/** The attempts behind one counted query, opened from the Queries tab. */
export function QueryAttemptsDrawer(props: QueryAttemptsDrawerProps) @{
	<Drawer
		open={props.query !== null}
		title={t('research.attempts.title')}
		subtitle={props.query?.query ?? ''}
		width="lg"
		onClose={props.onClose}
	>
		<div class="ui-drawer__body">
			<div class="ui-form">
				@if (props.status === 'error') {
					<Alert>{props.error}</Alert>
				} @else {
					<Table
						columns={columns()}
						rows={props.attempts}
						rowKey={(row) => row.id}
						status={props.status === 'loading' ? 'loading' : 'idle'}
						loadingLabel={t('research.common.loading')}
						empty={{
							icon: 'activity',
							title: t('research.attempts.emptyTitle'),
							hint: t('research.attempts.emptyHint'),
						}}
					/>
				}
			</div>
		</div>
	</Drawer>
}
