import { t } from '@flowdular/client';
import { Alert, Button, Drawer, Icon, PageHeader, Tag } from '@flowdular/ui';
import { useEffect, useMemo, type OctaneNode } from 'octane';
import { cell, createStore, useValue } from 'segment-state';
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
import { WORKFLOW_NODE_TYPES } from './canvas-model.ts';
import {
	addConnectedNode,
	type ConnectedNodeRequest,
} from './connected-node.ts';
import type { CanvasPoint } from './viewport.ts';
import { workflowInputSchema } from './input-model.ts';
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
	readonly dirty: boolean;
	readonly history: OctaneNode;
	readonly canManage: boolean;
	readonly canPublish: boolean;
	readonly canExecute: boolean;
	readonly canCancel: boolean;
	readonly onBack: () => void;
	readonly onName: (value: string) => void;
	readonly onDescription: (value: string) => void;
	readonly onAddNode: (type: WorkflowNodeType, request?: ConnectedNodeRequest) => void;
	readonly onSelectNode: (nodeId: string) => void;
	readonly onSelectEdge: (edgeId: string) => void;
	readonly onStartConnection: (nodeId: string, port: string) => void;
	readonly onFinishConnection: (nodeId: string, port: string) => void;
	readonly onCancelConnection: () => void;
	readonly onMoveNode: (nodeId: string, x: number, y: number) => void;
	readonly onReplaceNode: (node: WorkflowNodeV1) => void;
	readonly onReplaceGraph: (graph: WorkflowGraphV1) => void;
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
	const panels = useMemo(
		() => createStore({
			inspectorOpen: false,
			paletteOpen: false,
			panel: '',
			context: cell<(ConnectedNodeRequest & { screen: CanvasPoint }) | null>(
				null,
			),
		}),
		[],
	);
	const [inspectorOpen, setInspectorOpen] = useValue(
		panels.state.inspectorOpen,
	);
	const [paletteOpen, setPaletteOpen] = useValue(panels.state.paletteOpen);
	const [panel, setPanel] = useValue(panels.state.panel);
	const [context, setContext] = useValue(panels.state.context);
	useEffect(() => {
		if (props.selectedRun) {
			setPanel('history');
			setContext(null);
			setPaletteOpen(false);
		}
	}, [props.selectedRun?.run.id]);
	const contextTypes =
		context
			? WORKFLOW_NODE_TYPES.filter(
					(type) => addConnectedNode(props.graph, type, type, context) !== null,
				)
			: [];
	const selectNode = (id: string) => {
		if (id) setContext(null);
		setPaletteOpen(false);
		props.onSelectNode(id);
		setInspectorOpen(!!id);
	};
	const selectEdge = (id: string) => {
		if (id) setContext(null);
		setPaletteOpen(false);
		props.onSelectEdge(id);
		setInspectorOpen(!!id);
	};
	const published = props.detail.definition.publishedRevision !== null;
	const inspectingRun = props.selectedRun !== null;
	const canvasGraph = props.selectedRun?.graph ?? props.graph;
	const editorStatus =
		props.saving
			? t('workflows.editor.saving')
			: props.dirty
				? t('workflows.editor.unsaved')
				: t('workflows.editor.savedRevision', {
						revision: props.detail.draft.revision,
					});

	<div
		class="workflow-editor-view"
		onKeyDown={(event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setContext(null);
				setPaletteOpen(false);
			}
		}}
	>
		<PageHeader
			eyebrow={t('workflows.editor.eyebrow')}
			title={props.detail.definition.name}
			description={editorStatus}
		>
			<Button
				size="sm"
				disabled={props.dirty || props.saving}
				onClick={props.onBack}
			>
				<Icon name="x" size={14} />
				{t('workflows.editor.close')}
			</Button>
			<Button size="sm" onClick={() => setPanel('settings')}>{t(
				'workflows.editor.settings',
			)}</Button>
			@if (inspectingRun) {
				<Button
					size="sm"
					onClick={() => {
						props.onCloseRun();
						setPanel('');
					}}
				>{t('workflows.editor.backToDraft')}</Button>
			}
			<Button size="sm" onClick={() => setPanel('test')}>{t(
				'workflows.test.title',
			)}</Button>
			<Button size="sm" onClick={() => setPanel('history')}>{t(
				'workflows.history.title',
			)}</Button>
			@if (props.canPublish) {
				<Button
					size="sm"
					variant="primary"
					disabled={props.busy || props.dirty || props.saving || inspectingRun}
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
		@if (props.error && props.dirty && !props.saving) {
			<Button size="sm" onClick={() => props.onName(props.name)}>{t(
				'workflows.editor.retrySave',
			)}</Button>
		}
		@if (props.notice) {
			<Alert tone="info">{props.notice}</Alert>
		}
		<div
			class="workflow-builder"
			onPointerDown={(event: PointerEvent) => {
				if (
					!(event.target as Element).closest(
						'.workflow-context-palette,.workflow-add-control',
					)
				) {
					setContext(null);
					setPaletteOpen(false);
				}
			}}
		>
			<div class="workflow-add-control">
				<Button
					variant="primary"
					disabled={!props.canManage || inspectingRun}
					onClick={() => setPaletteOpen(!paletteOpen)}
				>
					<Icon name="plus" size={16} />
					{t('workflows.palette.add')}
				</Button>
				@if (paletteOpen) {
					<WorkflowNodePalette
						disabled={!props.canManage || inspectingRun}
						onAdd={(type) => {
							props.onAddNode(type);
							setPaletteOpen(false);
							setInspectorOpen(true);
						}}
					/>
				}
			</div>
			<WorkflowCanvas
				graph={canvasGraph}
				selectedNodeId={props.selectedNode?.id ?? ''}
				selectedEdgeId={props.selectedEdge?.id ?? ''}
				connectionSource={props.connectionSource}
				overlay={props.overlay}
				editable={props.canManage && !inspectingRun}
				onSelectNode={selectNode}
				onSelectEdge={selectEdge}
				onStartConnection={props.onStartConnection}
				onFinishConnection={props.onFinishConnection}
				onCancelConnection={props.onCancelConnection}
				onMoveNode={props.onMoveNode}
				onRemoveEdge={props.onRemoveEdge}
				onCreateConnected={(position, source, screen) => {
					setContext({ position, source, screen });
					setPaletteOpen(false);
					setInspectorOpen(false);
					props.onCancelConnection();
				}}
			/>
			@if (context) {
				<div
					class="workflow-context-palette"
					style={`left: min(${context.screen.x}px, max(var(--workflow-space), calc(100% - var(--control-h) * 8))); top: min(${context.screen.y}px, max(var(--workflow-space), calc(100% - var(--control-h) * 12)));`}
				>
					<div class="workflow-menu-heading">
						<span>{t('workflows.palette.add')}</span>
						<button
							class="ui-btn ui-btn--icon"
							type="button"
							aria-label={t('workflows.common.cancel')}
							onClick={() => setContext(null)}
						>
							<Icon name="x" size={14} />
						</button>
					</div>
					@if (contextTypes.length) {
						<WorkflowNodePalette
							compact
							disabled={!props.canManage || inspectingRun}
							types={contextTypes}
							onAdd={(type) => {
								props.onAddNode(type, context!);
								setContext(null);
								setInspectorOpen(true);
							}}
						/>
					} @else {
						<div class="workflow-panel__body">{t(
							'workflows.palette.noCompatible',
						)}</div>
					}
				</div>
			}
			@if (inspectorOpen && !!(props.selectedNode || props.selectedEdge)) {
				<aside
					class="workflow-floating-inspector"
					aria-label={t('workflows.inspector.detailsHelp')}
					onKeyDown={(event: KeyboardEvent) => {
						if (event.key === 'Escape') {
							event.stopPropagation();
							setInspectorOpen(false);
						}
					}}
				>
					<div class="workflow-panel-head workflow-panel-head--row">
						<b>
							{props.selectedNode?.label ?? t('workflows.inspector.edgeTitle')}
						</b>
						<Button size="sm" onClick={() => setInspectorOpen(false)}>{t(
							'workflows.common.close',
						)}</Button>
					</div>
					<WorkflowInspector
						graph={canvasGraph}
						node={props.selectedNode}
						edge={props.selectedEdge}
						agents={props.agents}
						actions={props.actions}
						editable={props.canManage && !inspectingRun}
						onReplaceNode={props.onReplaceNode}
						onReplaceGraph={props.onReplaceGraph}
						onRemoveNode={props.onRemoveNode}
						onRemoveEdge={props.onRemoveEdge}
					/>
				</aside>
			}
		</div>
		<Drawer
			open={panel === 'settings'}
			title={t('workflows.editor.settings')}
			width="lg"
			onClose={() => setPanel('')}
		>
			<div class="ui-drawer__body workflow-drawer-stack">
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
							onInput={(event) => props.onDescription(
								event.currentTarget.value,
							)}
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
				<details class="workflow-disclosure">
					<summary>{t('workflows.revision.title')}</summary>
					<div class="workflow-disclosure__body">
						<WorkflowRevisionReview detail={props.detail} graph={props.graph} />
					</div>
				</details>

				<details class="workflow-disclosure">
					<summary>{t('workflows.outline.title')}</summary>
					<div class="workflow-disclosure__body">
						<WorkflowOrderedOutline
							graph={canvasGraph}
							selectedNodeId={props.selectedNode?.id ?? ''}
							overlay={props.overlay}
							onSelect={selectNode}
						/>
					</div>
				</details>
			</div>
		</Drawer>
		<Drawer
			open={panel === 'test'}
			title={t('workflows.test.title')}
			width="lg"
			onClose={() => setPanel('')}
		>
			<div class="ui-drawer__body workflow-drawer-stack">
				<WorkflowValidationPanel
					report={props.validation}
					graph={props.graph}
					busy={props.validating}
				/>
				<WorkflowTestPanel
					inputSchema={workflowInputSchema(props.graph)}
					inputText={props.inputText}
					fixtureCount={props.graph.nodes.filter(
						(node) => ['agent', 'agent-decision', 'action'].includes(node.type),
					).length}
					busy={props.busy}
					canValidate={props.canExecute}
					canExecute={props.canExecute}
					published={published}
					unsaved={props.dirty || props.saving}
					error={props.error}
					onInput={props.onInput}
					onOpenFixtures={props.onOpenFixtures}
					onDryRun={props.onDryRun}
					onSimulate={props.onSimulate}
					onRunLive={props.onRunLive}
				/>
			</div>
		</Drawer>
		<Drawer
			open={panel === 'history'}
			title={t('workflows.history.title')}
			width="lg"
			onClose={() => setPanel('')}
		>
			<div class="ui-drawer__body workflow-drawer-stack">
				{props.history}
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
				@if (props.selectedRun) {
					<WorkflowRunInspector
						detail={props.selectedRun}
						selectedNodeId={props.selectedNode?.id ?? ''}
						canCancel={props.canCancel}
						canExecute={props.canExecute}
						busy={props.busy}
						onClose={props.onCloseRun}
						onCancel={props.onCancelRun}
						onRetry={props.onRetryRun}
					/>
				}
			</div>
		</Drawer>
	</div>
}
