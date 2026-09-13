import { t } from '@flowdular/client';
import {
	Pagination,
	SearchField,
	TableCard,
	Tag,
	type TableColumn,
	type TableSort,
} from '@flowdular/ui';
import type {
	AgentDefinition,
	AgentProviderConnection,
} from '../domain/types.ts';
import { stateTone, timestampLabel } from './presentation.ts';
import { hasMorePages, PAGE_SIZE, type CursorStack } from './state.ts';

export interface AgentDefinitionListProps {
	readonly agents: readonly AgentDefinition[];
	readonly status: 'idle' | 'loading';
	readonly providers: readonly AgentProviderConnection[];
	readonly filtered: boolean;
	readonly canManage: boolean;
	readonly query: string;
	readonly sorting: readonly TableSort[];
	readonly page: CursorStack;
	readonly onQuery: (value: string) => void;
	readonly onSortingChange: (sorts: readonly TableSort[]) => void;
	readonly onPageChange: (pageIndex: number) => void;
	readonly onSelect: (agentId: string) => void;
	readonly onArchive: (agentId: string) => void;
	readonly onDelete: (agentId: string) => void;
}

/* The two sortable columns carry the list's sort keys as their keys, so the
   sort the header reports is the sort the request sends. */
function columns(
	providers: readonly AgentProviderConnection[],
): readonly TableColumn<AgentDefinition>[] {
	const providerName = (id: string) =>
		providers.find((provider) => provider.id === id)?.name ??
			t('agents.definitions.unknownProvider');
	return [
		{
			key: 'name',
			header: t('agents.definitions.column.agent'),
			width: '22%',
			value: (agent) => agent.name,
			cell: (agent) => <span class="ui-cell">
				<b>{agent.name}</b>
				<small class="ui-mono">{agent.key + ' · r' + agent.revision}</small>
			</span>,
		},
		{
			key: 'purpose',
			header: t('agents.definitions.column.purpose'),
			width: '26%',
			cell: (agent) => <span class="ui-cell__muted">{agent.description}</span>,
		},
		{
			key: 'model',
			header: t('agents.definitions.column.model'),
			width: '20%',
			cell: (agent) => <span class="ui-cell">
				<b class="ui-mono">{agent.model}</b>
				<small>{providerName(agent.provider)}</small>
			</span>,
		},
		{
			key: 'updatedAt',
			header: t('agents.definitions.column.updated'),
			width: '18%',
			value: (agent) => agent.updatedAt,
			cell: (agent) => timestampLabel(agent.updatedAt),
		},
		{
			key: 'status',
			header: t('agents.definitions.column.status'),
			width: '14%',
			cell: (agent) =>
				<Tag tone={stateTone(agent.status)} dot>{t(
					'agents.status.' + agent.status,
				)}</Tag>,
		},
	];
}

export function AgentDefinitionList(props: AgentDefinitionListProps) @{
	<TableCard
		title={t('agents.definitions.table.title')}
		count={t('agents.definitions.table.count', {
			count: props.agents.length,
		})}
		search={<SearchField
			value={props.query}
			placeholder={t('agents.definitions.search.placeholder')}
			label={t('agents.definitions.search.label')}
			onInput={props.onQuery}
		/>}
		mode="server"
		columns={columns(props.providers)}
		rows={props.agents}
		status={props.status}
		loadingLabel={t('agents.definitions.loading')}
		rowKey={(agent) => agent.id}
		sorting
		sortingState={props.sorting}
		onSortingChange={props.onSortingChange}
		pagination={{
			pageIndex: props.page.pageIndex,
			pageSize: PAGE_SIZE,
			hasMore: hasMorePages(props.page),
			onPageChange: props.onPageChange,
		}}
		filtered={props.filtered}
		empty={{
			icon: 'bot',
			title: t('agents.definitions.empty.title'),
			hint: t('agents.definitions.empty.hint'),
		}}
		emptyFiltered={{
			icon: 'search',
			title: t('agents.definitions.empty.filteredTitle'),
			hint: t('agents.definitions.empty.filteredHint'),
		}}
		actionsLabel={t('agents.common.actions')}
		actionsWidth="280px"
		actions={props.canManage
			? (agent) => [
					{
						id: 'open',
						label: t('agents.common.edit'),
						onSelect: () => props.onSelect(agent.id),
					},
					...(agent.status === 'archived'
						? [
								{
									id: 'delete',
									label: t('agents.common.delete'),
									tone: 'danger' as const,
									onSelect: () => props.onDelete(agent.id),
								},
							]
						: [
								{
									id: 'archive',
									label: t('agents.common.archive'),
									onSelect: () => props.onArchive(agent.id),
								},
							]),
				]
			: undefined}
		onSelect={props.canManage ? (agent) => props.onSelect(agent.id) : undefined}
		caption={t('agents.definitions.table.caption')}
		after={<Pagination
			pageIndex={props.page.pageIndex}
			pageSize={PAGE_SIZE}
			hasMore={hasMorePages(props.page)}
			onPageChange={props.onPageChange}
			label={t('agents.common.page.label')}
			previousLabel={t('agents.common.page.previous')}
			nextLabel={t('agents.common.page.next')}
			summary={(page) => t('agents.common.page.summary', {
				page: page.pageIndex + 1,
				from: page.from,
			})}
		/>}
		note={t('agents.definitions.note')}
		noteIcon="shield"
	/>
}
