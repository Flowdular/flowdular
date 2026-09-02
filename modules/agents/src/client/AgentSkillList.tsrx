import { t } from '@coreloom/client';
import { SearchField, TableCard, Tag, type TableColumn } from '@coreloom/ui';
import type { AgentSkill } from '../domain/types.ts';
import { countLabel, stateTone } from './presentation.ts';

export interface AgentSkillListProps {
	readonly skills: readonly AgentSkill[];
	readonly filtered: boolean;
	readonly canManage: boolean;
	readonly query: string;
	readonly activeCount: number;
	readonly onQuery: (value: string) => void;
	readonly onSelect: (skillId: string) => void;
	readonly onArchive: (skillId: string) => void;
	readonly onDelete: (skillId: string) => void;
}

function columns(): readonly TableColumn<AgentSkill>[] {
	return [
		{
			key: 'skill',
			header: t('agents.skills.column.skill'),
			width: '26%',
			cell: (skill) => <span class="ui-cell">
				<b>{skill.name}</b>
				<small class="ui-mono">{skill.key + ' · r' + skill.revision}</small>
			</span>,
		},
		{
			key: 'purpose',
			header: t('agents.skills.column.purpose'),
			width: '35%',
			cell: (skill) => <span class="ui-cell__muted">{skill.description}</span>,
		},
		{
			key: 'tools',
			header: t('agents.skills.column.tools'),
			width: '12%',
			numeric: true,
			cell: (skill) => countLabel(skill.requiredTools.length),
		},
		{
			key: 'status',
			header: t('agents.skills.column.status'),
			width: '17%',
			cell: (skill) =>
				<Tag tone={stateTone(skill.status)} dot>{t(
					'agents.status.' + skill.status,
				)}</Tag>,
		},
	];
}

export function AgentSkillList(props: AgentSkillListProps) @{
	<TableCard
		title={t('agents.skills.table.title')}
		count={t('agents.skills.table.count', {
			active: props.activeCount,
			total: props.skills.length,
		})}
		search={<SearchField
			value={props.query}
			placeholder={t('agents.skills.search.placeholder')}
			label={t('agents.skills.search.label')}
			onInput={props.onQuery}
		/>}
		columns={columns()}
		rows={props.skills}
		rowKey={(skill) => skill.id}
		filtered={props.filtered}
		empty={{
			icon: 'file-text',
			title: t('agents.skills.empty.title'),
			hint: t('agents.skills.empty.hint'),
		}}
		emptyFiltered={{
			icon: 'search',
			title: t('agents.skills.empty.filteredTitle'),
			hint: t('agents.skills.empty.filteredHint'),
		}}
		actionsLabel={t('agents.common.actions')}
		actionsWidth="280px"
		actions={props.canManage
			? (skill) => [
					{
						id: 'open',
						label: t('agents.common.edit'),
						onSelect: () => props.onSelect(skill.id),
					},
					...(skill.status === 'archived'
						? [
								{
									id: 'delete',
									label: t('agents.common.delete'),
									tone: 'danger' as const,
									onSelect: () => props.onDelete(skill.id),
								},
							]
						: [
								{
									id: 'archive',
									label: t('agents.common.archive'),
									onSelect: () => props.onArchive(skill.id),
								},
							]),
				]
			: undefined}
		onSelect={props.canManage ? (skill) => props.onSelect(skill.id) : undefined}
		caption={t('agents.skills.table.caption')}
		note={t('agents.skills.note')}
		noteIcon="shield"
	/>
}
