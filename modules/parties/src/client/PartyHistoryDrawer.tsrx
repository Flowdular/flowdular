import type { HistoryEntry, HistoryValue } from '@coreloom/kernel';
import { activeLocale, t } from '@coreloom/client';
import { Alert, Drawer, TableCard, Tag, type TableColumn } from '@coreloom/ui';
import type { Party } from '../domain/types.ts';

export interface PartyHistoryDrawerProps {
	readonly open: boolean;
	readonly party: Party | null;
	readonly entries: readonly HistoryEntry[];
	readonly loading: boolean;
	readonly error: string;
	readonly onClose: () => void;
}

function value(input: HistoryValue): string {
	return input === null ? t('parties.history.emptyValue') : String(input);
}

function changes(entry: HistoryEntry): string {
	return Object.entries(entry.changes).map(
		([field, change]) => `${t('parties.history.field.' + field)}: ${value(
			change.from,
		)} → ${value(change.to)}`,
	).join(', ');
}

function date(value: number): string {
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(value));
}

function actorDetail(entry: HistoryEntry): string {
	if (entry.actor.kind !== 'service') {
		return t('parties.history.actor.' + entry.actor.kind);
	}
	return t('parties.history.actor.serviceConfiguredBy', {
		name: entry.actor.configuredBy.label,
	});
}

function columns(): readonly TableColumn<HistoryEntry>[] {
	return [
		{
			key: 'version',
			header: t('parties.history.column.version'),
			width: '10%',
			cell: (entry) => <span class="ui-mono">{'v' + entry.version}</span>,
		},
		{
			key: 'action',
			header: t('parties.history.column.action'),
			width: '18%',
			cell: (entry) =>
				<Tag
					tone={entry.action === 'deleted'
						? 'danger'
						: entry.action === 'archived'
							? 'warning'
							: 'neutral'}
				>{t('parties.history.action.' + entry.action)}</Tag>,
		},
		{
			key: 'actor',
			header: t('parties.history.column.actor'),
			width: '24%',
			cell: (entry) => <span class="ui-cell">
				<b>{entry.actor.label}</b>
				<small>{actorDetail(entry)}</small>
			</span>,
		},
		{
			key: 'changes',
			header: t('parties.history.column.changes'),
			width: '30%',
			cell: (entry) => <small>{changes(entry)}</small>,
		},
		{
			key: 'occurredAt',
			header: t('parties.history.column.date'),
			width: '18%',
			cell: (entry) => <small>{date(entry.occurredAt)}</small>,
		},
	];
}

export function PartyHistoryDrawer(props: PartyHistoryDrawerProps) @{
	<Drawer
		open={props.open}
		title={t('parties.history.title')}
		subtitle={props.party?.name ?? ''}
		width="lg"
		onClose={props.onClose}
	>
		<div class="ui-drawer__body">
			@if (props.error) {
				<Alert>{props.error}</Alert>
			}
			<TableCard
				title={t('parties.history.tableTitle')}
				count={t('parties.history.count', { count: props.entries.length })}
				caption={t('parties.history.caption')}
				columns={columns()}
				rows={props.entries}
				rowKey={(entry) => entry.id}
				status={props.loading ? 'loading' : 'idle'}
				loadingLabel={t('parties.history.loading')}
				empty={{
					icon: 'activity',
					title: t('parties.history.emptyTitle'),
					hint: t('parties.history.emptyHint'),
				}}
			/>
		</div>
	</Drawer>
}
