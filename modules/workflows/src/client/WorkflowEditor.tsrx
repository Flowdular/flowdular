import { t } from '@coreloom/client';
import { Alert, Button, Icon, PageHeader, Tag } from '@coreloom/ui';
import type {
	WorkflowDefinitionDetail,
	WorkflowDryRunResponseV1,
	WorkflowEdgeV1,
	WorkflowGraphV1,
	WorkflowNodeV1,
	WorkflowRunDetail,
} from '../domain/types.ts';
import type {
	WorkflowActionCatalogItem,
	WorkflowAgentCatalogItem,
} from './api.ts';
import type { WorkflowNodeType, WorkflowOverlay } from './canvas-model.ts';
import { WorkflowCanvas, WorkflowOrderedOutline } from './WorkflowCanvas.tsrx';
import { WorkflowInspector } from './WorkflowInspector.tsrx';
import { WorkflowNodePalette } from './WorkflowNodePalette.tsrx';
import { WorkflowRunInspector } from './WorkflowRunInspector.tsrx';
import { WorkflowRevisionReview } from './WorkflowRevisionReview.tsrx';
import { WorkflowTestPanel } from './WorkflowTestPanel.tsrx';
import { WorkflowValidationPanel } from './WorkflowValidationPanel.tsrx';

export interface WorkflowEditorProps {
	readonly detail: WorkflowDefinitionDetail;
	readonly graph: WorkflowGraphV1;
	readonly name: string;
	readonly description: string;
	readonly selectedNode: WorkflowNodeV1 | null;
	readonly selectedEdge: WorkflowEdgeV1 | null;
	readonly connectionSource: | {
			readonly nodeId: string;
			readonly port: string;
	  }
	| null;
	readonly validation: WorkflowDryRunResponseV1 | null;
	readonly validating: boolean;
	readonly selectedRun: WorkflowRunDetail | null;
	readonly overlay: WorkflowOverlay | null;
	readonly agents: readonly WorkflowAgentCatalogItem[];
	readonly actions: readonly WorkflowActionCatalogItem[];
	readonly inputText: string;
	readonly error: string;
	readonly notice: string;
	readonly busy: boolean;
	readonly saving: boolean;
	readonly canManage: boolean;
	readonly canPublish: boolean;
	readonly canExecute: boolean;
	readonly canCancel: boolean;
	readonly onBack: () => void;
	readonly onName: (value: string) => void;
	readonly onDescription: (value: string) => void;
	readonly onAddNode: (type: WorkflowNodeType) => void;
	readonly onSelectNode: (nodeId: string) => void;
	readonly onSelectEdge: (edgeId: string) => void;
	readonly onStartConnection: (nodeId: string, port: string) => void;
	readonly onFinishConnection: (nodeId: string, port: string) => void;
	readonly onMoveNode: (nodeId: string, x: number, y: number) => void;
	readonly onReplaceNode: (node: WorkflowNodeV1) => void;
	readonly onRemoveNode: (nodeId: string) => void;
	readonly onRemoveEdge: (edgeId: string) => void;
	readonly onDryRun: () => void;
	readonly onSimulate: () => void;
	readonly onRunLive: () => void;
	readonly onPublish: () => void;
	readonly onInput: (value: string) => void;
	readonly onOpenFixtures: () => void;
	readonly onCloseRun: () => void;
	readonly onCancelRun: () => void;
	readonly onRetryRun: () => void;
}

export function WorkflowEditor(props: WorkflowEditorProps) @{
	const published = props.detail.definition.publishedRevision !== null;
	const inspectingRun = props.selectedRun !== null;
	const canvasGraph = props.selectedRun?.graph ?? props.graph;
	const editorStatus =
		props.saving
			? t('workflows.editor.saving')
			: t('workflows.editor.savedRevision', {
					revision: props.detail.draft.revision,
				});

	<div class="ui-view workflow-editor-view">
		<PageHeader
			eyebrow={t('workflows.editor.eyebrow')}
			title={props.detail.definition.name}
			description={t('workflows.editor.description', {
				revision: props.detail.draft.revision,
			})}
		>
			<Button size="sm" onClick={props.onBack}>
				<Icon name="x" size={14} />
				{t('workflows.editor.close')}
			</Button>
			@if (props.canPublish) {
				<Button
					size="sm"
					variant="primary"
					disabled={props.busy || inspectingRun}
					onClick={props.onPublish}
				>
					<Icon name="check" size={14} />
					{t('workflows.editor.publish')}
				</Button>
			}
		</PageHeader>
		@if (props.error) {
			<Alert>{props.error}</Alert>
		}
		@if (props.notice) {
			<Alert tone="info">{props.notice}</Alert>
		}
		<section class="workflow-definition-bar">
			<label>
				<span class="ui-label">{t('workflows.editor.name')}</span>
				<input
					class="ui-input"
					value={props.name}
					disabled={!props.canManage || inspectingRun}
					maxlength={160}
					onInput={(event) => props.onName(event.currentTarget.value)}
				/>
			</label>
			<label class="workflow-definition-bar__description">
				<span class="ui-label">{t('workflows.editor.summary')}</span>
				<input
					class="ui-input"
					value={props.description}
					disabled={!props.canManage || inspectingRun}
					maxlength={500}
					onInput={(event) => props.onDescription(event.currentTarget.value)}
				/>
			</label>
			<Tag
				tone={props.detail.definition.status === 'active'
					? 'success'
					: 'neutral'}
				dot
			>{t('workflows.status.' + props.detail.definition.status)}</Tag>
			<small>{editorStatus}</small>
		</section>
		<WorkflowRevisionReview detail={props.detail} graph={props.graph} />
		<div class="workflow-builder">
			<WorkflowNodePalette
				disabled={!props.canManage || inspectingRun}
				onAdd={props.onAddNode}
			/>
			<WorkflowCanvas
				graph={canvasGraph}
				selectedNodeId={props.selectedNode?.id ?? ''}
				selectedEdgeId={props.selectedEdge?.id ?? ''}
				connectionSource={props.connectionSource}
				overlay={props.overlay}
				editable={props.canManage && !inspectingRun}
				onSelectNode={props.onSelectNode}
				onSelectEdge={props.onSelectEdge}
				onStartConnection={props.onStartConnection}
				onFinishConnection={props.onFinishConnection}
				onMoveNode={props.onMoveNode}
			/>
			<WorkflowInspector
				graph={canvasGraph}
				node={props.selectedNode}
				edge={props.selectedEdge}
				agents={props.agents}
				actions={props.actions}
				editable={props.canManage && !inspectingRun}
				onReplaceNode={props.onReplaceNode}
				onRemoveNode={props.onRemoveNode}
				onRemoveEdge={props.onRemoveEdge}
			/>
		</div>
		<WorkflowOrderedOutline
			graph={canvasGraph}
			selectedNodeId={props.selectedNode?.id ?? ''}
			overlay={props.overlay}
			onSelect={props.onSelectNode}
		/>
		<div class="workflow-lower-grid">
			<WorkflowValidationPanel
				report={props.validation}
				graph={props.graph}
				busy={props.validating}
			/>
			<WorkflowTestPanel
				inputText={props.inputText}
				fixtureCount={props.graph.nodes.filter(
					(node) => ['agent', 'agent-decision', 'action'].includes(node.type),
				).length}
				busy={props.busy}
				canValidate={props.canExecute}
				canExecute={props.canExecute}
				published={published}
				error=""
				onInput={props.onInput}
				onOpenFixtures={props.onOpenFixtures}
				onDryRun={props.onDryRun}
				onSimulate={props.onSimulate}
				onRunLive={props.onRunLive}
			/>
		</div>
		@if (props.selectedRun) {
			<WorkflowRunInspector
				detail={props.selectedRun}
				selectedNodeId={props.selectedNode?.id ?? ''}
				canCancel={props.canCancel}
				busy={props.busy}
				onClose={props.onCloseRun}
				onCancel={props.onCancelRun}
				onRetry={props.onRetryRun}
			/>
		}
	</div>
}
