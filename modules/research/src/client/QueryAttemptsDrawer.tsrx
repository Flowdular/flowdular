import { Alert, Drawer, Table, Tag, type TableColumn } from '@flowdular/ui';
import { t } from '@flowdular/client';
import type { ResearchAttemptRow, ResearchQueryRow } from './api.ts';
import {
	adapterLabel,
	attemptOutcomeLabel,
	attemptOutcomeTone,
	durationLabel,
	errorCodeLabel,
	timestampLabel,
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
			width: '24%',
			value: (row) => row.adapter,
			cell: (row) => <span class="ui-cell">
				<b>{adapterLabel(row.adapter)}</b>
				<small class="ui-cell__muted">{timestampLabel(row.createdAt)}</small>
			</span>,
		},
		{
			key: 'attempt',
			header: t('research.attempts.column.attempt'),
			width: '12%',
			numeric: true,
			value: (row) => row.attempt,
			cell: (row) => row.attempt === 0 ? '' : String(row.attempt),
		},
		{
			key: 'outcome',
			header: t('research.attempts.column.outcome'),
			width: '22%',
			value: (row) => row.outcome,
			cell: (row) =>
				<Tag tone={attemptOutcomeTone(row.outcome)} dot>{attemptOutcomeLabel(
					row.outcome,
				)}</Tag>,
		},
		{
			key: 'errorCode',
			header: t('research.attempts.column.error'),
			width: '28%',
			value: (row) => row.errorCode ?? '',
			cell: (row) => row.errorCode === null
				? ''
				: <span class="ui-cell">
						<b>{errorCodeLabel(row.errorCode)}</b>
						<small class="ui-mono">{row.errorCode}</small>
					</span>,
		},
		{
			key: 'durationMs',
			header: t('research.attempts.column.duration'),
			width: '14%',
			numeric: true,
			value: (row) => row.durationMs,
			cell: (row) => durationLabel(row.durationMs),
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
	</Drawer>
}
