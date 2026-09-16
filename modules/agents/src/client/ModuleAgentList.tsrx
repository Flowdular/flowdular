import { t } from '@flowdular/client';
import {
	CellStack,
	CellTag,
	CellText,
	SearchField,
	TableCard,
	type TableColumn,
} from '@flowdular/ui';
import type {
	AgentProviderConnection,
	ModuleAgentView,
} from '../domain/types.ts';
import { stateTone } from './presentation.ts';

export interface ModuleAgentListProps {
	readonly agents: readonly ModuleAgentView[];
	readonly status: 'idle' | 'loading';
	readonly providers: readonly AgentProviderConnection[];
	readonly filtered: boolean;
	readonly canManage: boolean;
	readonly query: string;
	readonly activeCount: number;
	readonly onQuery: (value: string) => void;
	readonly onConfigure: (agentId: string) => void;
}

function columns(
	providers: readonly AgentProviderConnection[],
): readonly TableColumn<ModuleAgentView>[] {
	const providerName = (id: string | null) => id === null
		? t('agents.moduleAgents.notConfigured')
		: providers.find((provider) => provider.id === id)?.name ??
			t('agents.definitions.unknownProvider');
	return [
		{
			key: 'agent',
			header: t('agents.moduleAgents.column.agent'),
			width: 'auto',
			cell: (agent) =>
				<CellStack
					primary={agent.name}
					secondary={agent.key + ' · d' + agent.ownership.definitionRevision}
					secondaryMono
				/>,
		},
		{
			key: 'module',
			header: t('agents.moduleAgents.column.module'),
			width: '180px',
			priority: 2,
			cell: (agent) => <CellText value={agent.ownership.moduleId} mono />,
		},
		{
			key: 'purpose',
			header: t('agents.moduleAgents.column.purpose'),
			width: 'auto',
			priority: 3,
			cell: (agent) => <CellText value={agent.description} wrap />,
		},
		{
			key: 'model',
			header: t('agents.moduleAgents.column.model'),
			width: '200px',
			priority: 2,
			cell: (agent) =>
				<CellStack
					primary={agent.model ?? t('agents.moduleAgents.notConfigured')}
					primaryMono={agent.model !== null}
					secondary={providerName(agent.provider)}
				/>,
		},
		{
			key: 'status',
			header: t('agents.moduleAgents.column.status'),
			width: '130px',
			cell: (agent) =>
				<CellTag
					tone={stateTone(agent.status)}
					dot
					label={t('agents.status.' + agent.status)}
				/>,
		},
	];
}

export function ModuleAgentList(props: ModuleAgentListProps) @{
	<TableCard
		title={t('agents.moduleAgents.table.title')}
		count={t('agents.moduleAgents.table.count', {
			active: props.activeCount,
			total: props.agents.length,
		})}
		search={<SearchField
			value={props.query}
			placeholder={t('agents.moduleAgents.search.placeholder')}
			label={t('agents.moduleAgents.search.label')}
			onInput={props.onQuery}
		/>}
		columns={columns(props.providers)}
		rows={props.agents}
		status={props.status}
		loadingLabel={t('agents.moduleAgents.loading')}
		rowKey={(agent) => agent.id}
		filtered={props.filtered}
		empty={{
			icon: 'bot',
			title: t('agents.moduleAgents.empty.title'),
			hint: t('agents.moduleAgents.empty.hint'),
		}}
		emptyFiltered={{
			icon: 'search',
			title: t('agents.moduleAgents.empty.filteredTitle'),
			hint: t('agents.moduleAgents.empty.filteredHint'),
		}}
		actionsLabel={t('agents.common.actions')}
		actionsWidth="140px"
		actions={props.canManage
			? (agent) => [
					{
						id: 'configure',
						label: t('agents.moduleAgents.configure'),
						onSelect: () => props.onConfigure(agent.id),
					},
				]
			: undefined}
		onSelect={props.canManage
			? (agent) => props.onConfigure(agent.id)
			: undefined}
		caption={t('agents.moduleAgents.table.caption')}
		note={t('agents.moduleAgents.note')}
		noteIcon="shield"
	/>
}
