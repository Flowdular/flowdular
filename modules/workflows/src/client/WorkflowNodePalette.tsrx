import { t } from '@flowdular/client';
import { Icon } from '@flowdular/ui';
import type { WorkflowActionCatalogItem } from './api.ts';
import {
	namedWorkflowActions,
	WORKFLOW_NODE_TYPES,
	type WorkflowNodeType,
} from './canvas-model.ts';

export interface WorkflowNodePaletteProps {
	readonly disabled: boolean;
	readonly types?: readonly WorkflowNodeType[];
	readonly actions: readonly WorkflowActionCatalogItem[];
	readonly compact?: boolean;
	readonly onAdd: (type: WorkflowNodeType) => void;
	readonly onAddAction: (action: WorkflowActionCatalogItem) => void;
}

function icon(type: WorkflowNodeType): string {
	if (type === 'agent' || type === 'agent-decision') return 'bot';
	if (type === 'gate') return 'shield';
	if (type === 'validator') return 'check';
	if (type === 'action') return 'plug';
	if (type === 'human-approval') return 'user';
	if (type === 'input') return 'download';
	if (type === 'output') return 'external';
	return 'modules';
}

export function WorkflowNodePalette(props: WorkflowNodePaletteProps) @{
	const entries = (props.types ?? WORKFLOW_NODE_TYPES).map(
		(type) => ({
			key: type,
			type,
			icon: icon(type),
			label: t('workflows.nodeType.' + type),
		}),
	);
	const templates = namedWorkflowActions(props.actions);

	<aside
		class={props.compact ? 'workflow-palette-inline' : 'workflow-palette'}
		aria-label={t('workflows.palette.label')}
	>
		<div class="workflow-palette__items">
			@for (const entry of entries; key entry.key) {
				<button
					class="workflow-palette__item"
					type="button"
					disabled={props.disabled}
					onClick={() => props.onAdd(entry.type)}
				>
					<Icon name={entry.icon} size={16} />
					<span>{entry.label}</span>
				</button>
			}
			@if (templates.length > 0) {
				<>
					<div class="workflow-palette__heading">{t(
						'workflows.palette.templates',
					)}</div>
					@for (const action of templates; key action.actionId + '@' +
						action.contractVersion) {
						<button
							class="workflow-palette__item workflow-palette__template"
							type="button"
							disabled={props.disabled}
							onClick={() => props.onAddAction(action)}
						>
							<Icon name="plug" size={16} />
							<span class="ui-cell">
								<b>
									{action.workflowTemplate?.label}
								</b>
								<small>
									{action.workflowTemplate?.description}
								</small>
								@if (action.workflowTemplate?.effect === 'connector-egress') {
									<small>{t('workflows.palette.connectorEgress')}</small>
								}
							</span>
						</button>
					}
				</>
			}
		</div>
	</aside>
}
