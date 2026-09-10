import { t } from '@flowdular/client';
import { SearchField, TableCard, Tag, type TableColumn } from '@flowdular/ui';
import type {
	AgentDefinition,
	AgentProviderConnection,
} from '../domain/types.ts';
import { stateTone } from './presentation.ts';

export interface AgentDefinitionListProps {
	readonly agents: readonly AgentDefinition[];
	readonly status: 'idle' | 'loading';
	readonly providers: readonly AgentProviderConnection[];
	readonly filtered: boolean;
	readonly canManage: boolean;
	readonly query: string;
	readonly activeCount: number;
	readonly onQuery: (value: string) => void;
	readonly onSelect: (agentId: string) => void;
	readonly onArchive: (agentId: string) => void;
	readonly onDelete: (agentId: string) => void;
}

function columns(
	providers: readonly AgentProviderConnection[],
): readonly TableColumn<AgentDefinition>[] {
	const providerName = (id: string) =>
		providers.find((provider) => provider.id === id)?.name ??
			t('agents.definitions.unknownProvider');
	return [
		{
			key: 'agent',
			header: t('agents.definitions.column.agent'),
			width: '23%',
			cell: (agent) => <span class="ui-cell">
				<b>{agent.name}</b>
				<small class="ui-mono">{agent.key + ' · r' + agent.revision}</small>
			</span>,
		},
		{
			key: 'purpose',
			header: t('agents.definitions.column.purpose'),
			width: '30%',
			cell: (agent) => <span class="ui-cell__muted">{agent.description}</span>,
		},
		{
			key: 'model',
			header: t('agents.definitions.column.model'),
			width: '21%',
			cell: (agent) => <span class="ui-cell">
				<b class="ui-mono">{agent.model}</b>
				<small>{providerName(agent.provider)}</small>
			</span>,
		},
		{
			key: 'status',
			header: t('agents.definitions.column.status'),
			width: '16%',
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
			active: props.activeCount,
			total: props.agents.length,
		})}
		search={<SearchField
			value={props.query}
			placeholder={t('agents.definitions.search.placeholder')}
			label={t('agents.definitions.search.label')}
			onInput={props.onQuery}
		/>}
		columns={columns(props.providers)}
		rows={props.agents}
		status={props.status}
		loadingLabel={t('agents.definitions.loading')}
		rowKey={(agent) => agent.id}
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
		note={t('agents.definitions.note')}
		noteIcon="shield"
	/>
}
