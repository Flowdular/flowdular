import type { HistoryEntry, HistoryValue } from '@flowdular/sdk/kernel';
import { activeLocale, t } from '@flowdular/sdk/client';
import {
	Alert,
	Drawer,
	TableCard,
	Tag,
	type TableColumn,
} from '@flowdular/sdk/ui';
import type { CatalogItem } from '../domain/types.ts';

export interface CatalogHistoryDrawerProps {
	readonly open: boolean;
	readonly item: CatalogItem | null;
	readonly entries: readonly HistoryEntry[];
	readonly loading: boolean;
	readonly error: string;
	readonly onClose: () => void;
}

function value(input: HistoryValue): string {
	return input === null ? t('catalog.history.emptyValue') : String(input);
}

function changes(entry: HistoryEntry): string {
	return Object.entries(entry.changes).map(
		([field, change]) => `${t('catalog.history.field.' + field)}: ${value(
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
		return t('catalog.history.actor.' + entry.actor.kind);
	}
	return t('catalog.history.actor.serviceConfiguredBy', {
		name: entry.actor.configuredBy.label,
	});
}

function columns(): readonly TableColumn<HistoryEntry>[] {
	return [
		{
			key: 'version',
			header: t('catalog.history.column.version'),
			width: '10%',
			cell: (entry) => <span class="ui-mono">{'v' + entry.version}</span>,
		},
		{
			key: 'action',
			header: t('catalog.history.column.action'),
			width: '18%',
			cell: (entry) =>
				<Tag
					tone={entry.action === 'deleted'
						? 'danger'
						: entry.action === 'archived'
							? 'warning'
							: 'neutral'}
				>{t('catalog.history.action.' + entry.action)}</Tag>,
		},
		{
			key: 'actor',
			header: t('catalog.history.column.actor'),
			width: '24%',
			cell: (entry) => <span class="ui-cell">
				<b>{entry.actor.label}</b>
				<small>{actorDetail(entry)}</small>
			</span>,
		},
		{
			key: 'changes',
			header: t('catalog.history.column.changes'),
			width: '30%',
			cell: (entry) => <small>{changes(entry)}</small>,
		},
		{
			key: 'occurredAt',
			header: t('catalog.history.column.date'),
			width: '18%',
			cell: (entry) => <small>{date(entry.occurredAt)}</small>,
		},
	];
}

export function CatalogHistoryDrawer(props: CatalogHistoryDrawerProps) @{
	<Drawer
		open={props.open}
		title={t('catalog.history.title')}
		subtitle={props.item?.name ?? ''}
		width="lg"
		onClose={props.onClose}
	>
		<div class="ui-drawer__body">
			@if (props.error) {
				<Alert>{props.error}</Alert>
			}
			<TableCard
				title={t('catalog.history.tableTitle')}
				count={t('catalog.history.count', { count: props.entries.length })}
				caption={t('catalog.history.caption')}
				columns={columns()}
				rows={props.entries}
				rowKey={(entry) => entry.id}
				status={props.loading ? 'loading' : 'idle'}
				loadingLabel={t('catalog.history.loading')}
				empty={{
					icon: 'activity',
					title: t('catalog.history.emptyTitle'),
					hint: t('catalog.history.emptyHint'),
				}}
			/>
		</div>
	</Drawer>
}
