import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	CellMuted,
	CellNumber,
	CellStack,
	CellText,
	CellTime,
	EmptyState,
	Icon,
	PageHeader,
	TableCard,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import type { AccessAttestation } from '../domain/types.ts';
import { AccessApiError, accessErrorMessage, loadAttestations } from './api.ts';
import { dateLabel, numberLabel, screenSurface } from './presentation.ts';
import { createAttestationsClientState } from './state.ts';

export interface AttestationsViewProps {
	readonly csrfToken: string;
}

/* The period and who attested it stay on screen; the counts hide next and the
   note first. */
function columns(): readonly TableColumn<AccessAttestation>[] {
	return [
		{
			key: 'period',
			header: t('access.attestations.column.period'),
			width: '220px',
			value: (row) => row.periodFrom,
			cell: (row) =>
				<CellStack
					primary={dateLabel(row.periodFrom) + ' - ' + dateLabel(row.periodTo)}
					secondary={<CellTime value={row.createdAt} />}
				/>,
		},
		{
			key: 'reviewer',
			header: t('access.attestations.column.reviewer'),
			width: '220px',
			value: (row) => row.reviewerLabel,
			cell: (row) => <CellText value={row.reviewerLabel} />,
		},
		{
			key: 'members',
			header: t('access.attestations.column.members'),
			width: '130px',
			numeric: true,
			priority: 2,
			value: (row) => row.memberCount,
			cell: (row) => <CellText
				value={t('access.attestations.membersValue', {
					total: numberLabel(row.memberCount),
					active: numberLabel(row.activeMemberCount),
				})}
			/>,
		},
		{
			key: 'extraScopes',
			header: t('access.attestations.column.extraScopes'),
			width: '130px',
			numeric: true,
			priority: 2,
			value: (row) => row.extraScopeCount,
			cell: (row) => <CellNumber value={row.extraScopeCount} />,
		},
		{
			key: 'tokens',
			header: t('access.attestations.column.tokens'),
			width: '100px',
			numeric: true,
			priority: 2,
			value: (row) => row.tokenCount,
			cell: (row) => <CellNumber value={row.tokenCount} />,
		},
		{
			key: 'note',
			header: t('access.attestations.column.note'),
			width: 'auto',
			priority: 3,
			value: (row) => row.note ?? '',
			cell: (row) => row.note === null
				? <CellMuted>{t('access.attestations.noNote')}</CellMuted>
				: <CellText value={row.note} wrap />,
		},
	];
}

export function AttestationsView(_props: AttestationsViewProps) @{
	const client = useMemo(() => createAttestationsClientState(), []);
	const [attestations] = useValue(client.state.attestations);
	const [loaded] = useValue(client.state.loaded);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [cursor] = useValue(client.state.cursor);
	const surface = screenSurface(status);

	const load = async (next: string | null) => {
		setStatus('loading');
		setError('');
		try {
			const page = await loadAttestations(next);
			client.store.act((transaction) => {
				transaction.set(
					client.state.attestations,
					next === null ? page.items : [...attestations, ...page.items],
				);
				transaction.set(client.state.cursor, page.page.nextCursor);
				transaction.set(client.state.loaded, true);
				transaction.set(client.state.status, 'idle');
			}, 'access/attestations-loaded');
		} catch (loadError) {
			setError(accessErrorMessage(loadError, 'access.attestations.error.load'));
			setStatus(
				loadError instanceof AccessApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void load(null);
	}, []);

	<div class="ui-view">
		<PageHeader
			eyebrow={t('access.common.administration')}
			title={t('access.attestations.title')}
			description={t('access.attestations.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void load(null)}
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
					'access.attestations.denied',
				)}</EmptyState>
			</section>
		} @else if (surface === 'error') {
			<Alert>{error}</Alert>
		} @else {
			<TableCard
				title={t('access.attestations.table.title')}
				count={t('access.attestations.count', { count: attestations.length })}
				caption={t('access.attestations.caption')}
				columns={columns()}
				rows={attestations}
				rowKey={(row) => row.id}
				status={status === 'loading' && !loaded ? 'loading' : 'idle'}
				loadingLabel={t('access.common.loading')}
				empty={{
					icon: 'check',
					title: t('access.attestations.emptyTitle'),
					hint: t('access.attestations.emptyHint'),
				}}
				after={cursor === null
					? undefined
					: <div class="ui-form__actions">
							<Button
								size="sm"
								disabled={status === 'loading'}
								onClick={() => void load(cursor)}
							>{t('access.attestations.more')}</Button>
						</div>}
				noteIcon="shield"
				note={t('access.attestations.note')}
			/>
		}
	</div>
}
