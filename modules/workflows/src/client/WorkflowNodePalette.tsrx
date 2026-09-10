import { t } from '@flowdular/client';
import { Icon } from '@flowdular/ui';
import { WORKFLOW_NODE_TYPES, type WorkflowNodeType } from './canvas-model.ts';

export interface WorkflowNodePaletteProps {
	readonly disabled: boolean;
	readonly types?: readonly WorkflowNodeType[];
	readonly compact?: boolean;
	readonly onAdd: (type: WorkflowNodeType) => void;
}

function icon(type: WorkflowNodeType): string {
	if (type === 'agent' || type === 'agent-decision') return 'bot';
	if (type === 'gate') return 'shield';
	if (type === 'validator') return 'check';
	if (type === 'action') return 'plug';
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
		</div>
	</aside>
}
