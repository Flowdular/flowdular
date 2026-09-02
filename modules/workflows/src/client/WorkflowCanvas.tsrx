import { t } from '@coreloom/client';
import { Icon, Tag, type TagTone } from '@coreloom/ui';
import type {
	WorkflowGraphV1,
	WorkflowNodeExecution,
	WorkflowNodeV1,
} from '../domain/types.ts';
import {
	edgeCoordinates,
	workflowOutline,
	type WorkflowOverlay,
} from './canvas-model.ts';

export interface WorkflowCanvasProps {
	readonly graph: WorkflowGraphV1;
	readonly selectedNodeId: string;
	readonly selectedEdgeId: string;
	readonly connectionSource: | {
			readonly nodeId: string;
			readonly port: string;
	  }
	| null;
	readonly overlay: WorkflowOverlay | null;
	readonly editable: boolean;
	readonly onSelectNode: (nodeId: string) => void;
	readonly onSelectEdge: (edgeId: string) => void;
	readonly onStartConnection: (nodeId: string, port: string) => void;
	readonly onFinishConnection: (nodeId: string, port: string) => void;
	readonly onMoveNode: (nodeId: string, x: number, y: number) => void;
}

function nodeTone(status: WorkflowNodeExecution['status']): TagTone {
	if (status === 'succeeded') return 'success';
	if (status === 'failed' || status === 'refused') return 'danger';
	if (status === 'running' || status === 'waiting-child') return 'info';
	if (status === 'waiting-retry') return 'warning';
	return 'neutral';
}

function WorkflowNodeCard(props: {
	readonly node: WorkflowNodeV1;
	readonly x: number;
	readonly y: number;
	readonly selected: boolean;
	readonly sourcePort: string;
	readonly status: WorkflowNodeExecution['status'] | null;
	readonly editable: boolean;
	readonly onSelect: () => void;
	readonly onStartConnection: (port: string) => void;
	readonly onFinishConnection: (port: string) => void;
	readonly onMove: (x: number, y: number) => void;
}) @{
	const inputPorts = props.node.inputPorts.map(
		(port) => ({ key: port.name, port }),
	);
	const outputPorts = props.node.outputPorts.map(
		(port) => ({ key: port.name, port }),
	);
	const beginDrag = (event: PointerEvent) => {
		if (!props.editable || event.button !== 0) return;
		event.preventDefault();
		const startX = event.clientX;
		const startY = event.clientY;
		const move = (next: PointerEvent) => {
			props.onMove(
				props.x + next.clientX - startX,
				props.y + next.clientY - startY,
			);
		};
		const finish = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', finish);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', finish, { once: true });
	};

	<article
		class={[
			'workflow-node',
			props.selected && 'is-selected',
			props.status && `is-${props.status}`,
		]}
		style={`transform: translate(${props.x}px, ${props.y}px);`}
		onClick={props.onSelect}
	>
		<header class="workflow-node__head">
			<button
				class="workflow-node__drag"
				type="button"
				disabled={!props.editable}
				aria-label={t('workflows.canvas.moveNode', { name: props.node.label })}
				onPointerDown={beginDrag}
			>
				<Icon name="more" size={14} />
			</button>
			<span class="ui-cell">
				<b>{props.node.label}</b>
				<small>{t('workflows.nodeType.' + props.node.type)}</small>
			</span>
			@if (props.status) {
				<Tag tone={nodeTone(props.status)} dot>{t(
					'workflows.nodeStatus.' + props.status,
				)}</Tag>
			}
		</header>
		<div class="workflow-node__ports">
			<div class="workflow-node__port-list">
				@for (const entry of inputPorts; key entry.key) {
					<button
						class="workflow-port workflow-port--input"
						type="button"
						disabled={!props.editable}
						aria-label={t('workflows.canvas.connectInput', {
							port: entry.port.name,
							name: props.node.label,
						})}
						onClick={(event: MouseEvent) => {
							event.stopPropagation();
							props.onFinishConnection(entry.port.name);
						}}
					>{entry.port.name}</button>
				}
			</div>
			<div class="workflow-node__port-list workflow-node__port-list--output">
				@for (const entry of outputPorts; key entry.key) {
					<button
						class={[
							'workflow-port',
							'workflow-port--output',
							props.sourcePort === entry.port.name && 'is-connecting',
						]}
						type="button"
						disabled={!props.editable}
						aria-label={t('workflows.canvas.connectOutput', {
							port: entry.port.name,
							name: props.node.label,
						})}
						onClick={(event: MouseEvent) => {
							event.stopPropagation();
							props.onStartConnection(entry.port.name);
						}}
					>{entry.port.name}</button>
				}
			</div>
		</div>
	</article>
}

export function WorkflowCanvas(props: WorkflowCanvasProps) @{
	const edges = props.graph.edges.map(
		(edge) => ({
			key: edge.id,
			edge,
			geometry: edgeCoordinates(edge, props.graph.layout),
			state: props.overlay?.edges[edge.id] ?? null,
		}),
	);
	const nodes = props.graph.nodes.map(
		(node) => ({
			key: node.id,
			node,
			position: props.graph.layout[node.id] ?? { x: 0, y: 0 },
			status: props.overlay?.nodes[node.id] ?? null,
		}),
	);

	<section
		class="workflow-canvas-card"
		aria-label={t('workflows.canvas.label')}
	>
		<div class="workflow-panel-head workflow-panel-head--row">
			<span class="ui-cell">
				<b>{t('workflows.canvas.title')}</b>
				<small>
					{props.editable
						? t('workflows.canvas.description')
						: t('workflows.canvas.readOnly')}
				</small>
			</span>
			@if (props.connectionSource) {
				<Tag tone="info">{t('workflows.canvas.connecting', {
					port: props.connectionSource.port,
				})}</Tag>
			}
		</div>
		<div class="workflow-canvas" onClick={() => props.onSelectEdge('')}>
			<svg class="workflow-canvas__edges" aria-hidden="true">
				@for (const entry of edges; key entry.key) {
					<line
						class={[
							'workflow-edge',
							props.selectedEdgeId === entry.edge.id && 'is-selected',
							entry.state && `is-${entry.state}`,
						]}
						x1={entry.geometry.x1}
						y1={entry.geometry.y1}
						x2={entry.geometry.x2}
						y2={entry.geometry.y2}
						onClick={(event: MouseEvent) => {
							event.stopPropagation();
							props.onSelectEdge(entry.edge.id);
						}}
					/>
				}
			</svg>
			@for (const entry of nodes; key entry.key) {
				<WorkflowNodeCard
					node={entry.node}
					x={entry.position.x}
					y={entry.position.y}
					selected={props.selectedNodeId === entry.node.id}
					sourcePort={props.connectionSource?.nodeId === entry.node.id
						? props.connectionSource.port
						: ''}
					status={entry.status}
					editable={props.editable}
					onSelect={() => props.onSelectNode(entry.node.id)}
					onStartConnection={(port) => props.onStartConnection(
						entry.node.id,
						port,
					)}
					onFinishConnection={(port) => props.onFinishConnection(
						entry.node.id,
						port,
					)}
					onMove={(x, y) => props.onMoveNode(entry.node.id, x, y)}
				/>
			}
		</div>
	</section>
}

export function WorkflowOrderedOutline(props: {
	readonly graph: WorkflowGraphV1;
	readonly selectedNodeId: string;
	readonly overlay: WorkflowOverlay | null;
	readonly onSelect: (nodeId: string) => void;
}) @{
	const nodes = workflowOutline(props.graph).map(
		(node, index) => ({
			key: node.id,
			node,
			index: index + 1,
			status: props.overlay?.nodes[node.id] ?? null,
		}),
	);

	<section class="workflow-outline" aria-label={t('workflows.outline.label')}>
		<div class="workflow-panel-head">
			<b>{t('workflows.outline.title')}</b>
			<small>{t('workflows.outline.description')}</small>
		</div>
		<ol>
			@for (const entry of nodes; key entry.key) {
				<li>
					<button
						class={[
							'workflow-outline__item',
							props.selectedNodeId === entry.node.id && 'is-selected',
						]}
						type="button"
						onClick={() => props.onSelect(entry.node.id)}
					>
						<span class="num">{entry.index}</span>
						<span class="ui-cell">
							<b>{entry.node.label}</b>
							<small>{t('workflows.nodeType.' + entry.node.type)}</small>
						</span>
						@if (entry.status) {
							<Tag tone={nodeTone(entry.status)} dot>{t(
								'workflows.nodeStatus.' + entry.status,
							)}</Tag>
						}
					</button>
				</li>
			}
		</ol>
	</section>
}
