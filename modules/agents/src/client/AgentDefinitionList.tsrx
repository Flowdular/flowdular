import { Button, EmptyState, Tag } from '@coreloom/ui';
import type {
	AgentDefinition,
	AgentProviderConnection,
} from '../domain/types.ts';
import { stateTone } from './presentation.ts';

export interface AgentDefinitionListProps {
	readonly agents: readonly AgentDefinition[];
	readonly providers: readonly AgentProviderConnection[];
	readonly filtered: boolean;
	readonly canManage: boolean;
	readonly onSelect: (agentId: string) => void;
}

export function AgentDefinitionList(props: AgentDefinitionListProps) @{
	const providerName = (id: string) =>
		props.providers.find((provider) => provider.id === id)?.name ??
			'Unknown provider';

	<div>
		@if (props.agents.length === 0) {
			<EmptyState
				icon="bot"
				title={props.filtered ? 'No matching agents' : 'No agents configured'}
			>
				{props.filtered
					? 'No definition in this workspace matches the current filter.'
					: 'Create a bounded definition, review it, and activate it.'}
			</EmptyState>
		} @else {
			<div class="ui-table-wrap">
				<table class="ui-table" aria-label="Agent definitions">
					<thead>
						<tr>
							<th>Agent</th>
							<th>Purpose</th>
							<th>Model</th>
							<th>Status</th>
							<th class="ui-table__actions"></th>
						</tr>
					</thead>
					<tbody>
						@for (const agent of props.agents; key agent.id) {
							<tr class="is-clickable" onClick={() => props.onSelect(agent.id)}>
								<td>
									<span class="ui-cell">
										<b>{agent.name}</b>
										<small class="ui-mono">
											{agent.key + ' · r' + agent.revision}
										</small>
									</span>
								</td>
								<td class="ui-cell__muted">{agent.description}</td>
								<td>
									<span class="ui-cell">
										<b class="ui-mono">{agent.model}</b>
										<small>{providerName(agent.provider)}</small>
									</span>
								</td>
								<td>
									<Tag tone={stateTone(agent.status)} dot>{agent.status}</Tag>
								</td>
								<td class="ui-table__actions">
									<Button size="sm" onClick={() => props.onSelect(agent.id)}>
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
