import type { HistoryEntry, HistoryValue } from '@coreloom/kernel';
import { activeLocale, t } from '@coreloom/client';
import { Alert, Drawer, TableCard, Tag, type TableColumn } from '@coreloom/ui';
import type { ExpensesClaim } from '../domain/types.ts';

export interface ExpenseHistoryDrawerProps {
	readonly open: boolean;
	readonly claim: ExpensesClaim | null;
	readonly entries: readonly HistoryEntry[];
	readonly loading: boolean;
	readonly error: string;
	readonly onClose: () => void;
}

function value(input: HistoryValue): string {
	return input === null ? t('expenses.history.emptyValue') : String(input);
}

function changes(entry: HistoryEntry): string {
	return Object.entries(entry.changes).map(
		([field, change]) => `${t('expenses.history.field.' + field)}: ${value(
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
		return t('expenses.history.actor.' + entry.actor.kind);
	}
	return t('expenses.history.actor.serviceConfiguredBy', {
		name: entry.actor.configuredBy.label,
	});
}

function columns(): readonly TableColumn<HistoryEntry>[] {
	return [
		{
			key: 'version',
			header: t('expenses.history.column.version'),
			width: '10%',
			cell: (entry) => <span class="ui-mono">{'v' + entry.version}</span>,
		},
		{
			key: 'action',
			header: t('expenses.history.column.action'),
			width: '18%',
			cell: (entry) =>
				<Tag
					tone={entry.action === 'rejected'
						? 'danger'
						: entry.action === 'approved'
							? 'success'
							: entry.action === 'submitted'
								? 'warning'
								: 'neutral'}
				>{t('expenses.history.action.' + entry.action)}</Tag>,
		},
		{
			key: 'actor',
			header: t('expenses.history.column.actor'),
			width: '24%',
			cell: (entry) => <span class="ui-cell">
				<b>{entry.actor.label}</b>
				<small>{actorDetail(entry)}</small>
			</span>,
		},
		{
			key: 'changes',
			header: t('expenses.history.column.changes'),
			width: '30%',
			cell: (entry) => <small>{changes(entry)}</small>,
		},
		{
			key: 'occurredAt',
			header: t('expenses.history.column.date'),
			width: '18%',
			cell: (entry) => <small>{date(entry.occurredAt)}</small>,
		},
	];
}

export function ExpenseHistoryDrawer(props: ExpenseHistoryDrawerProps) @{
	<Drawer
		open={props.open}
		title={t('expenses.history.title')}
		subtitle={props.claim?.title ?? ''}
		width="lg"
		onClose={props.onClose}
	>
		<div class="ui-drawer__body">
			@if (props.error) {
				<Alert>{props.error}</Alert>
			}
			<TableCard
				title={t('expenses.history.tableTitle')}
				count={t('expenses.history.count', { count: props.entries.length })}
				caption={t('expenses.history.caption')}
				columns={columns()}
				rows={props.entries}
				rowKey={(entry) => entry.id}
				status={props.loading ? 'loading' : 'idle'}
				loadingLabel={t('expenses.history.loading')}
				empty={{
					icon: 'activity',
					title: t('expenses.history.emptyTitle'),
					hint: t('expenses.history.emptyHint'),
				}}
			/>
		</div>
	</Drawer>
}
