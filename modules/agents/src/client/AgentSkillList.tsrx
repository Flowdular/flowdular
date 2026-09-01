import { Button, EmptyState, Tag } from '@coreloom/ui';
import type { AgentSkill } from '../domain/types.ts';
import { stateTone } from './presentation.ts';

export interface AgentSkillListProps {
	readonly skills: readonly AgentSkill[];
	readonly filtered: boolean;
	readonly canManage: boolean;
	readonly onSelect: (skillId: string) => void;
}

export function AgentSkillList(props: AgentSkillListProps) @{
	<div>
		@if (props.skills.length === 0) {
			<EmptyState
				icon="file-text"
				title={props.filtered ? 'No matching skills' : 'No skills yet'}
			>
				{props.filtered
					? 'No skill in this workspace matches the current filter.'
					: 'A skill is a reusable procedure an agent can attach: instructions plus the tools it needs.'}
			</EmptyState>
		} @else {
			<div class="ui-table-wrap">
				<table class="ui-table" aria-label="Agent skills">
					<thead>
						<tr>
							<th>Skill</th>
							<th>Purpose</th>
							<th class="num">Tools</th>
							<th>Status</th>
							<th class="ui-table__actions"></th>
						</tr>
					</thead>
					<tbody>
						@for (const skill of props.skills; key skill.id) {
							<tr class="is-clickable" onClick={() => props.onSelect(skill.id)}>
								<td>
									<span class="ui-cell">
										<b>{skill.name}</b>
										<small class="ui-mono">
											{skill.key + ' · r' + skill.revision}
										</small>
									</span>
								</td>
								<td class="ui-cell__muted">{skill.description}</td>
								<td class="num">{skill.requiredTools.length}</td>
								<td>
									<Tag tone={stateTone(skill.status)} dot>{skill.status}</Tag>
								</td>
								<td class="ui-table__actions">
									<Button size="sm" onClick={() => props.onSelect(skill.id)}>
										{props.canManage ? 'Edit' : 'View'}
									</Button>
								</td>
							</tr>
						}
					</tbody>
				</table>
			</div>
		}
	</div>
}
