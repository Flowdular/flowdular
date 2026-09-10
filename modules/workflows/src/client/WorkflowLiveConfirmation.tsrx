import { t } from '@flowdular/client';
import type {
	WorkflowDryRunResponseV1,
	WorkflowGraphV1,
} from '../domain/types.ts';
import type {
	WorkflowActionCatalogItem,
	WorkflowAgentCatalogItem,
} from './api.ts';

export function WorkflowLiveConfirmation(props: {
	readonly graph: WorkflowGraphV1 | null;
	readonly report: WorkflowDryRunResponseV1 | null;
	readonly agents: readonly WorkflowAgentCatalogItem[];
	readonly actions: readonly WorkflowActionCatalogItem[];
}) @{
	const agentReferences = (props.graph?.nodes ?? []).flatMap((node) => {
		if (node.type !== 'agent' && node.type !== 'agent-decision') return [];
		const catalog = props.agents.find(
			(agent) =>
				agent.agentId === node.agent.agentId &&
					agent.revision === node.agent.revision,
		);
		return [
			catalog
				? `${catalog.name} (r${catalog.revision})`
				: `${node.agent.agentId} (r${node.agent.revision})`,
		];
	});
	const actionReferences = (props.graph?.nodes ?? []).flatMap((node) => {
		if (node.type !== 'action') return [];
		const catalog = props.actions.find(
			(action) =>
				action.actionId === node.action.actionId &&
					action.contractVersion === node.action.contractVersion,
		);
		const name = catalog?.label ?? node.action.actionId;
		const risk =
			catalog?.risk === 'workspace-write'
				? t('workflows.liveConfirm.writeRisk')
				: t('workflows.liveConfirm.readRisk');
		return [`${name} (${risk})`];
	});
	const permissions = props.report?.requiredPermissions ?? [];

	<span class="workflow-live-summary">
		<span>{t('workflows.liveConfirm.description')}</span>
		<span class="workflow-live-summary__section">
			<b>{t('workflows.liveConfirm.agents')}</b>
			<small>
				{agentReferences.join(', ') || t('workflows.liveConfirm.noAgents')}
			</small>
		</span>
		<span class="workflow-live-summary__section">
			<b>{t('workflows.liveConfirm.actions')}</b>
			<small>
				{actionReferences.join(', ') || t('workflows.liveConfirm.noActions')}
			</small>
		</span>
		<span class="workflow-live-summary__section">
			<b>{t('workflows.liveConfirm.permissions')}</b>
			<small class="ui-mono">
				{permissions.join(', ') || t('workflows.common.none')}
			</small>
		</span>
	</span>
}
