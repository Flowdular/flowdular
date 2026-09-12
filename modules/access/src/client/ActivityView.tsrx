import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	DateRangeField,
	EmptyState,
	Icon,
	PageHeader,
	TableCard,
	Tabs,
	Tag,
	dateRangeReversed,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import type { AccessChange } from '../domain/types.ts';
import { AccessApiError, accessErrorMessage, loadChanges } from './api.ts';
import {
	categoryLabel,
	isoDaysBefore,
	screenSurface,
	timestampLabel,
	todayIso,
} from './presentation.ts';
import { createActivityClientState } from './state.ts';

export interface ActivityViewProps {
	readonly csrfToken: string;
}

const CATEGORY_TONES: Readonly<
	Record<string, 'info' | 'warning' | 'neutral'>
> = {
	membership: 'info',
	role: 'warning',
	scope: 'warning',
	token: 'warning',
	provider: 'info',
	settings: 'neutral',
	security: 'warning',
};

function columns(): readonly TableColumn<AccessChange>[] {
	return [
		{
			key: 'occurredAt',
			header: t('access.activity.column.time'),
			width: '18%',
			value: (row) => row.occurredAt,
			cell: (row) => timestampLabel(row.occurredAt),
		},
		{
			key: 'category',
			header: t('access.activity.column.category'),
			width: '14%',
			value: (row) => row.category,
			cell: (row) =>
				<Tag tone={CATEGORY_TONES[row.category] ?? 'neutral'}>{categoryLabel(
					row.category,
				)}</Tag>,
		},
		{
			key: 'action',
			header: t('access.activity.column.action'),
			width: '22%',
			value: (row) => row.action,
			cell: (row) => <span class="ui-mono">{row.action}</span>,
		},
		{
			key: 'actor',
			header: t('access.activity.column.actor'),
			width: '20%',
			value: (row) => row.actor,
			cell: (row) => <span class="ui-cell">
				<b>{row.actor}</b>
				<small>{row.actorKind}</small>
			</span>,
		},
		{
			key: 'subject',
			header: t('access.activity.column.subject'),
			width: '26%',
			value: (row) => row.subjectType + ' ' + row.subjectId,
			cell: (row) => <span class="ui-cell">
				<b class="ui-mono">{row.subjectType + ' ' + row.subjectId}</b>
				{row.detail ? <small class="ui-mono">{row.detail}</small> : null}
			</span>,
		},
	];
}

export function ActivityView(_props: ActivityViewProps) @{
	const client = useMemo(() => createActivityClientState(), []);
	const [changes] = useValue(client.state.changes);
	const [loaded] = useValue(client.state.loaded);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [kind, setKind] = useValue(client.state.kind);
	const [from, setFrom] = useValue(client.state.from);
	const [to, setTo] = useValue(client.state.to);
	const [cursor] = useValue(client.state.cursor);
	const surface = screenSurface(status);
	const reversed = dateRangeReversed(from, to);

	/* A page appends, a new window replaces: the reader is paging one report,
   not accumulating two. */
	const load = async (
		reportKind: 'diff' | 'activity',
		range: { readonly from: string; readonly to: string },
		next: string | null,
	) => {
		setStatus('loading');
		setError('');
		try {
			const page = await loadChanges(reportKind, {
				from: range.from,
				to: range.to,
				cursor: next,
			});
			client.store.act((transaction) => {
				transaction.set(
					client.state.changes,
					next === null ? page.items : [...changes, ...page.items],
				);
				transaction.set(client.state.cursor, page.page.nextCursor);
				transaction.set(client.state.source, page.source);
				transaction.set(client.state.loaded, true);
				transaction.set(client.state.status, 'idle');
			}, 'access/changes-loaded');
		} catch (loadError) {
			setError(accessErrorMessage(loadError, 'access.activity.error.load'));
			setStatus(
				loadError instanceof AccessApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		const start = isoDaysBefore(30);
		const end = todayIso();
		client.store.act((transaction) => {
			transaction.set(client.state.from, start);
			transaction.set(client.state.to, end);
		}, 'access/range-defaulted');
		void load('diff', { from: start, to: end }, null);
	}, []);

	const apply = (reportKind: 'diff' | 'activity') => {
		if (reversed || from === '' || to === '') return;
		setKind(reportKind);
		void load(reportKind, { from, to }, null);
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('access.common.administration')}
			title={t('access.activity.title')}
			description={t('access.activity.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied' || reversed}
				onClick={() => apply(kind)}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('access.common.refreshing')
					: t('access.common.refresh')}
			</Button>
		</PageHeader>
		@if (surface === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('access.common.accessDenied')}>{t(
					'access.activity.denied',
				)}</EmptyState>
			</section>
		} @else if (surface === 'error') {
			<Alert>{error}</Alert>
		} @else {
			<>
				<Tabs
					id="access-activity"
					items={[
						{ id: 'diff', label: t('access.activity.tab.diff') },
						{ id: 'activity', label: t('access.activity.tab.activity') },
					]}
					active={kind}
					onChange={(id: string) => apply(id === 'diff' ? 'diff' : 'activity')}
					label={t('access.activity.tabsLabel')}
				/>
				<div id={'access-activity-panel-' + kind} role="tabpanel">
					<TableCard
						title={t(
							kind === 'diff'
								? 'access.activity.diff.title'
								: 'access.activity.activity.title',
						)}
						count={t('access.activity.count', { count: changes.length })}
						head={<DateRangeField
							id="access-activity-range"
							legend={t('access.activity.range')}
							fromLabel={t('access.activity.from')}
							toLabel={t('access.activity.to')}
							value={{ from, to }}
							reversedMessage={t('access.activity.reversed')}
							onChange={(value: { from: string; to: string }) => {
								setFrom(value.from);
								setTo(value.to);
							}}
						/>}
						caption={t('access.activity.caption')}
						columns={columns()}
						rows={changes}
						rowKey={(row) => String(row.id)}
						status={status === 'loading' && !loaded ? 'loading' : 'idle'}
						loadingLabel={t('access.common.loading')}
						empty={{
							icon: 'activity',
							title: t(
								kind === 'diff'
									? 'access.activity.diff.emptyTitle'
									: 'access.activity.activity.emptyTitle',
							),
							hint: t('access.activity.emptyHint'),
						}}
						after={cursor === null
							? undefined
							: <div class="ui-form__actions">
									<Button
										size="sm"
										disabled={status === 'loading'}
										onClick={() => void load(kind, { from, to }, cursor)}
									>{t('access.activity.more')}</Button>
								</div>}
						noteIcon="info"
						note={t('access.activity.note')}
					/>
				</div>
			</>
		}
	</div>
}
