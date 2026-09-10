import { t } from '@flowdular/client';
import { SearchField, TableCard, Tag, type TableColumn } from '@flowdular/ui';
import type { AgentProcedure } from '../domain/types.ts';
import { countLabel, stateTone } from './presentation.ts';

export interface AgentProcedureListProps {
	readonly procedures: readonly AgentProcedure[];
	readonly filtered: boolean;
	readonly canManage: boolean;
	readonly query: string;
	readonly activeCount: number;
	readonly onQuery: (value: string) => void;
	readonly onSelect: (procedureId: string) => void;
	readonly onArchive: (procedureId: string) => void;
	readonly onDelete: (procedureId: string) => void;
}

function columns(): readonly TableColumn<AgentProcedure>[] {
	return [
		{
			key: 'procedure',
			header: t('agents.procedures.column.procedure'),
			width: '26%',
			cell: (procedure) => <span class="ui-cell">
				<b>{procedure.name}</b>
				<small class="ui-mono">
					{procedure.key + ' · r' + procedure.revision}
				</small>
			</span>,
		},
		{
			key: 'purpose',
			header: t('agents.procedures.column.purpose'),
			width: '35%',
			cell: (procedure) =>
				<span class="ui-cell__muted">{procedure.description}</span>,
		},
		{
			key: 'tools',
			header: t('agents.procedures.column.tools'),
			width: '12%',
			numeric: true,
			cell: (procedure) => countLabel(procedure.requiredTools.length),
		},
		{
			key: 'status',
			header: t('agents.procedures.column.status'),
			width: '17%',
			cell: (procedure) =>
				<Tag tone={stateTone(procedure.status)} dot>{t(
					'agents.status.' + procedure.status,
				)}</Tag>,
		},
	];
}

export function AgentProcedureList(props: AgentProcedureListProps) @{
	<TableCard
		title={t('agents.procedures.table.title')}
		count={t('agents.procedures.table.count', {
			active: props.activeCount,
			total: props.procedures.length,
		})}
		search={<SearchField
			value={props.query}
			placeholder={t('agents.procedures.search.placeholder')}
			label={t('agents.procedures.search.label')}
			onInput={props.onQuery}
		/>}
		columns={columns()}
		rows={props.procedures}
		rowKey={(procedure) => procedure.id}
		filtered={props.filtered}
		empty={{
			icon: 'file-text',
			title: t('agents.procedures.empty.title'),
			hint: t('agents.procedures.empty.hint'),
		}}
		emptyFiltered={{
			icon: 'search',
			title: t('agents.procedures.empty.filteredTitle'),
			hint: t('agents.procedures.empty.filteredHint'),
		}}
		actionsLabel={t('agents.common.actions')}
		actionsWidth="280px"
		actions={props.canManage
			? (procedure) => [
					{
						id: 'open',
						label: t('agents.common.edit'),
						onSelect: () => props.onSelect(procedure.id),
					},
					...(procedure.status === 'archived'
						? [
								{
									id: 'delete',
									label: t('agents.common.delete'),
									tone: 'danger' as const,
									onSelect: () => props.onDelete(procedure.id),
								},
							]
						: [
								{
									id: 'archive',
									label: t('agents.common.archive'),
									onSelect: () => props.onArchive(procedure.id),
								},
							]),
				]
			: undefined}
		onSelect={props.canManage
			? (procedure) => props.onSelect(procedure.id)
			: undefined}
		caption={t('agents.procedures.table.caption')}
		note={t('agents.procedures.note')}
		noteIcon="shield"
	/>
}
