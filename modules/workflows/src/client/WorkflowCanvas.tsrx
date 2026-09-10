import { activeLocale, t } from '@flowdular/client';
import { Button, Icon, Tag, type TagTone } from '@flowdular/ui';
import { useEffect, useMemo, useRef } from 'octane';
import { cell, createStore, useValue } from 'segment-state';
import type {
	WorkflowGraphV1,
	WorkflowNodeExecution,
	WorkflowNodeV1,
} from '../domain/types.ts';
import {
	edgeCoordinates,
	proposeWorkflowConnection,
	workflowOutline,
	type WorkflowOverlay,
} from './canvas-model.ts';
import {
	canvasPoint,
	connectionPath,
	DEFAULT_VIEWPORT,
	draggedNode,
	fitCanvas,
	MAX_ZOOM,
	MIN_ZOOM,
	snapPoint,
	zoomCanvas,
	type CanvasPoint,
	type CanvasViewport,
} from './viewport.ts';

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
	readonly onCancelConnection: () => void;
	readonly onCreateConnected: (position: CanvasPoint, source: {
		nodeId: string;
		port: string;
	}, screen: CanvasPoint) => void;
	readonly onRemoveEdge: (edgeId: string) => void;
	readonly onMoveNode: (nodeId: string, x: number, y: number) => void;
}

function nodeTone(status: WorkflowNodeExecution['status']): TagTone {
	if (status === 'succeeded') return 'success';
	if (status === 'failed' || status === 'refused') return 'danger';
	if (status === 'running' || status === 'waiting-child') return 'info';
	if (status === 'waiting-retry') return 'warning';
	return 'neutral';
}

function portTone(port: string): string {
	return port === 'failure' || port === 'fail'
		? 'failure'
		: port === 'success' || port === 'pass'
			? 'success'
			: 'data';
}

function WorkflowNodeCard(props: {
	readonly node: WorkflowNodeV1;
	readonly position: CanvasPoint;
	readonly selected: boolean;
	readonly sourcePort: string;
	readonly targetPort: string;
	readonly targetValid: boolean;
	readonly status: WorkflowNodeExecution['status'] | null;
	readonly editable: boolean;
	readonly onSelect: () => void;
	readonly onStartConnection: (port: string) => void;
	readonly onFinishConnection: (port: string) => void;
	readonly onMove: (x: number, y: number) => void;
}) @{
	<article
		class={[
			'workflow-node',
			props.selected && 'is-selected',
			props.status && `is-${props.status}`,
		]}
		style={`transform: translate(${props.position.x}px, ${props.position.y}px);`}
		data-workflow-node={props.node.id}
		onClick={(event: MouseEvent) => {
			event.stopPropagation();
			props.onSelect();
		}}
	>
		<header class="workflow-node__head" data-workflow-drag={props.node.id}>
			<button
				class="workflow-node__drag"
				type="button"
				aria-label={t('workflows.canvas.moveNode', { name: props.node.label })}
				disabled={!props.editable}
				onKeyDown={(event: KeyboardEvent) => {
					const delta = event.shiftKey ? 50 : 10;
					const moves: Record<string, CanvasPoint> = {
						ArrowLeft: { x: -delta, y: 0 },
						ArrowRight: { x: delta, y: 0 },
						ArrowUp: { x: 0, y: -delta },
						ArrowDown: { x: 0, y: delta },
					};
					const move = moves[event.key];
					if (!move) return;
					event.preventDefault();
					event.stopPropagation();
					props.onMove(props.position.x + move.x, props.position.y + move.y);
				}}
			>
				<Icon name="more" size={14} />
			</button>
			<button
				class="workflow-node__select"
				type="button"
				aria-label={t('workflows.canvas.editNode', { name: props.node.label })}
			>
				<span class="ui-cell">
					<b>{props.node.label}</b>
					<small>{t('workflows.nodeType.' + props.node.type)}</small>
				</span>
			</button>
			@if (props.status) {
				<Tag tone={nodeTone(props.status)} dot>{t(
					'workflows.nodeStatus.' + props.status,
				)}</Tag>
			}
		</header>
		<div class="workflow-node__ports">
			<div class="workflow-node__port-list">
				@for (const port of props.node.inputPorts; key port.name) {
					<button
						class={[
							'workflow-port',
							'workflow-port--input',
							props.targetPort === port.name &&
								(props.targetValid ? 'is-target' : 'is-invalid'),
						]}
						type="button"
						data-workflow-input={props.node.id}
						data-workflow-port={port.name}
						disabled={!props.editable}
						aria-label={t('workflows.canvas.connectInput', {
							port: port.name,
							name: props.node.label,
						})}
						onClick={(event: MouseEvent) => {
							event.stopPropagation();
							props.onFinishConnection(port.name);
						}}
					>
						<span class="workflow-port__dot" />
						{port.name}
					</button>
				}
			</div>
			<div class="workflow-node__port-list workflow-node__port-list--output">
				@for (const port of props.node.outputPorts; key port.name) {
					<button
						class={[
							'workflow-port',
							'workflow-port--output',
							'workflow-port--' + portTone(port.name),
							props.sourcePort === port.name && 'is-connecting',
						]}
						type="button"
						data-workflow-output={props.node.id}
						data-workflow-port={port.name}
						disabled={!props.editable}
						aria-label={t('workflows.canvas.connectOutput', {
							port: port.name,
							name: props.node.label,
						})}
						onClick={(event: MouseEvent) => {
							event.stopPropagation();
							if (event.detail === 0) props.onStartConnection(port.name);
						}}
					>
						{port.name}
						<span class="workflow-port__dot" />
					</button>
				}
			</div>
		</div>
	</article>
}

interface Gesture {
	readonly kind: 'pan' | 'node' | 'connection';
	readonly pointerId: number;
	readonly start: CanvasPoint;
	readonly viewport: CanvasViewport;
	readonly origin: CanvasPoint;
	readonly nodeId: string;
	readonly port: string;
	moved: boolean;
	position?: CanvasPoint;
}
interface ConnectionPreview {
	readonly start: CanvasPoint;
	readonly end: CanvasPoint;
	readonly nodeId: string;
	readonly port: string;
	readonly targetId: string;
	readonly targetPort: string;
	readonly valid: boolean;
}

export function WorkflowCanvas(props: WorkflowCanvasProps) @{
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const gesture = useRef<Gesture | null>(null);
	const suppressClick = useRef(false);
	const latest = useRef(props);
	latest.current = props;
	const store = useMemo(
		() => createStore({
			view: cell<CanvasViewport>(DEFAULT_VIEWPORT),
			preview: cell<ConnectionPreview | null>(null),
			dragPosition: cell<{ nodeId: string; position: CanvasPoint } | null>(
				null,
			),
			ports: cell<Readonly<Record<string, CanvasPoint>>>({}),
		}),
		[],
	);
	const [view, setView] = useValue(store.state.view);
	const [preview, setPreview] = useValue(store.state.preview);
	const [dragPosition, setDragPosition] = useValue(store.state.dragPosition);
	const dragFrame = useRef<number | null>(null);
	const [ports, setPorts] = useValue(store.state.ports);
	const viewRef = useRef(view);
	viewRef.current = view;

	const gestureCleanup = () => {
		const active = gesture.current;
		gesture.current = null;
		if (
			active && viewportRef.current?.hasPointerCapture(active.pointerId)
		) viewportRef.current.releasePointerCapture(active.pointerId);
		if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
		dragFrame.current = null;
		setDragPosition(null);
		setPreview(null);
	};
	useEffect(
		() => () => {
			if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
			const active = gesture.current;
			gesture.current = null;
			if (
				active && viewportRef.current?.hasPointerCapture(active.pointerId)
			) viewportRef.current.releasePointerCapture(active.pointerId);
		},
		[],
	);

	const localPoint = (event: {
		clientX: number;
		clientY: number;
	}): CanvasPoint => {
		const rect = viewportRef.current?.getBoundingClientRect();
		return {
			x: event.clientX - (rect?.left ?? 0),
			y: event.clientY - (rect?.top ?? 0),
		};
	};
	const fit = () => {
		const element = viewportRef.current;
		if (element) setView(
			fitCanvas(
				latest.current.graph,
				element.clientWidth,
				element.clientHeight,
			),
		);
	};
	const zoom = (factor: number) => {
		const element = viewportRef.current;
		if (element) setView(
			zoomCanvas(viewRef.current, viewRef.current.zoom * factor, {
				x: element.clientWidth / 2,
				y: element.clientHeight / 2,
			}),
		);
	};

	// Measure real port centers so wrapped labels and multi-port nodes keep their arrows attached.
	useEffect(() => {
		const element = viewportRef.current;
		if (!element) return;
		let measured: Readonly<Record<string, CanvasPoint>> = {};
		let frame: number | null = null;
		const measure = () => {
			frame = null;
			const next: Record<string, CanvasPoint> = {};
			for (const port of element.querySelectorAll<HTMLElement>(
				'[data-workflow-port]',
			)) {
				const dot =
					port.querySelector('.workflow-port__dot')?.getBoundingClientRect() ??
						port.getBoundingClientRect();
				const direction = port.dataset.workflowInput ? 'in' : 'out';
				const nodeId =
					port.dataset.workflowInput ?? port.dataset.workflowOutput;
				const bounds = port.closest(
					'[data-workflow-node]',
				)?.getBoundingClientRect();
				if (!bounds) continue;
				next[JSON.stringify([nodeId, direction, port.dataset.workflowPort])] = {
					x: (dot.left + dot.width / 2 - bounds.left) / viewRef.current.zoom,
					y: (dot.top + dot.height / 2 - bounds.top) / viewRef.current.zoom,
				};
			}
			if (
				Object.keys(next).length !== Object.keys(measured).length ||
					Object.entries(next).some(
						([key, point]) =>
							!measured[key] || Math.abs(measured[key]!.x - point.x) > 0.01 ||
								Math.abs(measured[key]!.y - point.y) > 0.01,
					)
			) {
				measured = next;
				setPorts(next);
			}
		};
		measure();
		const observer = new ResizeObserver(() => {
			if (frame === null) frame = requestAnimationFrame(measure);
		});
		observer.observe(element);
		for (const node of element.querySelectorAll(
			'.workflow-node',
		)) observer.observe(node);
		return () => {
			observer.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [props.graph, view.zoom]);

	useEffect(() => {
		const element = viewportRef.current;
		if (!element) return;
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			if (gesture.current) return;
			if (event.ctrlKey || event.metaKey) {
				setView(
					zoomCanvas(
						viewRef.current,
						viewRef.current.zoom * Math.exp(-event.deltaY * 0.01),
						localPoint(event),
					),
				);
			} else {
				const unit =
					event.deltaMode === 1
						? 16
						: event.deltaMode === 2
							? element.clientHeight
							: 1;
				setView({
					...viewRef.current,
					x: viewRef.current.x - event.deltaX * unit,
					y: viewRef.current.y - event.deltaY * unit,
				});
			}
		};
		element.addEventListener('wheel', wheel, { passive: false });
		return () => element.removeEventListener('wheel', wheel);
	}, []);

	const begin = (event: PointerEvent) => {
		if (
			gesture.current || !event.isPrimary ||
				event.button !== 0 && event.button !== 1
		) return;
		const target = event.target as Element;
		const output = target.closest<HTMLElement>('[data-workflow-output]');
		const drag = target.closest<HTMLElement>('[data-workflow-drag]');
		const pan =
			event.button === 1 ||
				!target.closest('.workflow-node') && !target.closest('.workflow-edge');
		const kind =
			pan
				? 'pan'
				: props.editable && output
					? 'connection'
					: props.editable && drag
						? 'node'
						: null;
		if (!kind) return;
		event.preventDefault();
		suppressClick.current = false;
		const nodeId =
			output?.dataset.workflowOutput ?? drag?.dataset.workflowDrag ?? '';
		const port = output?.dataset.workflowPort ?? '';
		const point = localPoint(event);
		const origin =
			kind === 'node'
				? props.graph.layout[nodeId] ?? { x: 0, y: 0 }
				: canvasPoint(point, view);
		gesture.current = {
			kind,
			pointerId: event.pointerId,
			start: { x: event.clientX, y: event.clientY },
			viewport: view,
			origin,
			nodeId,
			port,
			moved: false,
		};
		viewportRef.current?.setPointerCapture(event.pointerId);
		if (kind === 'connection') {
			props.onStartConnection(nodeId, port);
			setPreview({
				start: origin,
				end: origin,
				nodeId,
				port,
				targetId: '',
				targetPort: '',
				valid: false,
			});
		}
	};
	const move = (event: PointerEvent) => {
		const active = gesture.current;
		if (!active || event.pointerId !== active.pointerId) return;
		const delta = {
			x: event.clientX - active.start.x,
			y: event.clientY - active.start.y,
		};
		if (Math.hypot(delta.x, delta.y) > 3) active.moved = true;
		if (!active.moved) return;
		if (active.kind === 'pan') {
			setView({
				...active.viewport,
				x: active.viewport.x + delta.x,
				y: active.viewport.y + delta.y,
			});
		} else if (active.kind === 'node') {
			const next = draggedNode(active.origin, delta, active.viewport.zoom);
			active.position = next;
			if (dragFrame.current === null) dragFrame.current = requestAnimationFrame(
				() => {
					dragFrame.current = null;
					if (gesture.current === active && active.position) setDragPosition({
						nodeId: active.nodeId,
						position: active.position,
					});
				},
			);
		} else {
			const target = document.elementFromPoint(
				event.clientX,
				event.clientY,
			)?.closest<HTMLElement>('[data-workflow-input]');
			const targetId = target?.dataset.workflowInput ?? '';
			const targetPort = target?.dataset.workflowPort ?? '';
			const valid =
				!!targetId &&
					proposeWorkflowConnection(
						latest.current.graph,
						active.nodeId,
						active.port,
						targetId,
						targetPort,
					).valid;
			setPreview({
				start: active.origin,
				end: canvasPoint(localPoint(event), viewRef.current),
				nodeId: active.nodeId,
				port: active.port,
				targetId,
				targetPort,
				valid,
			});
		}
	};
	const finish = (event: PointerEvent, cancelled = false) => {
		const active = gesture.current;
		if (!active || event.pointerId !== active.pointerId) return;
		suppressClick.current = active.moved || cancelled;
		if (active.kind === 'node' && !active.moved && !cancelled) {
			latest.current.onSelectNode(active.nodeId);
			suppressClick.current = true;
		}
		if (active.kind === 'node' && active.moved && !cancelled) {
			const next = snapPoint(
				draggedNode(
					active.origin,
					{
						x: event.clientX - active.start.x,
						y: event.clientY - active.start.y,
					},
					active.viewport.zoom,
				),
			);
			latest.current.onMoveNode(active.nodeId, next.x, next.y);
		}
		if (active.kind === 'connection' && active.moved && !cancelled) {
			const target = document.elementFromPoint(
				event.clientX,
				event.clientY,
			)?.closest<HTMLElement>('[data-workflow-input]');
			if (
				target?.dataset.workflowInput && target.dataset.workflowPort &&
					proposeWorkflowConnection(
						latest.current.graph,
						active.nodeId,
						active.port,
						target.dataset.workflowInput,
						target.dataset.workflowPort,
					).valid
			) latest.current.onFinishConnection(
				target.dataset.workflowInput,
				target.dataset.workflowPort,
			);
			else if (
				!target &&
					viewportRef.current?.contains(
						document.elementFromPoint(event.clientX, event.clientY),
					)
			) {
				const screen = localPoint(event);
				latest.current.onCreateConnected(
					snapPoint(canvasPoint(screen, viewRef.current)),
					{ nodeId: active.nodeId, port: active.port },
					screen,
				);
			}
		}
		if (active.kind === 'connection') suppressClick.current = true;
		if (
			cancelled || active.kind === 'connection' && active.moved
		) latest.current.onCancelConnection();
		gestureCleanup();
	};

	const positionOf = (id: string) => dragPosition?.nodeId === id
		? dragPosition.position
		: props.graph.layout[id] ?? { x: 0, y: 0 };
	const portPosition = (
		id: string,
		direction: string,
		port: string,
		fallback: CanvasPoint,
	): CanvasPoint => {
		const offset = ports[JSON.stringify([id, direction, port])];
		const position = positionOf(id);
		return offset
			? { x: position.x + offset.x, y: position.y + offset.y }
			: fallback;
	};
	const edges = props.graph.edges.map((edge) => {
		const fallback = edgeCoordinates(edge, props.graph.layout);
		const source = portPosition(edge.source.nodeId, 'out', edge.source.port, {
			x: fallback.x1,
			y: fallback.y1,
		});
		const target = portPosition(edge.target.nodeId, 'in', edge.target.port, {
			x: fallback.x2,
			y: fallback.y2,
		});
		return {
			edge,
			path: connectionPath(source, target),
			state: props.overlay?.edges[edge.id] ?? null,
		};
	});

	<section
		class="workflow-canvas-card"
		aria-label={t('workflows.canvas.label')}
	>
		<div class="workflow-canvas-controls">
			<button
				class="ui-btn ui-btn--sm"
				type="button"
				aria-label={t('workflows.canvas.zoomOut')}
				title={t('workflows.canvas.zoomOut')}
				disabled={view.zoom <= MIN_ZOOM}
				onClick={() => zoom(1 / 1.2)}
			>−</button>
			<button
				class="ui-btn ui-btn--sm ui-mono"
				type="button"
				title={t('workflows.canvas.reset')}
				onClick={() => setView(DEFAULT_VIEWPORT)}
			>{new Intl.NumberFormat(activeLocale(), {
				style: 'percent',
				maximumFractionDigits: 0,
			}).format(view.zoom)}</button>
			<button
				class="ui-btn ui-btn--sm"
				type="button"
				aria-label={t('workflows.canvas.zoomIn')}
				title={t('workflows.canvas.zoomIn')}
				disabled={view.zoom >= MAX_ZOOM}
				onClick={() => zoom(1.2)}
			>+</button>
			<Button size="sm" onClick={fit}>{t('workflows.canvas.fit')}</Button>
		</div>
		@if (props.connectionSource) {
			<div class="workflow-connection-hint">
				<span>{t('workflows.canvas.connecting', {
					port: props.connectionSource.port,
				})}</span>
				<Button
					size="sm"
					onClick={() => {
						gestureCleanup();
						props.onCancelConnection();
					}}
				>{t('workflows.common.cancel')}</Button>
			</div>
		}
		<div
			class="workflow-canvas"
			ref={viewportRef}
			style={`background-position: ${view.x}px ${view.y}px; background-size: ${
				24 * view.zoom
			}px ${24 * view.zoom}px;`}
			tabindex={0}
			aria-label={t('workflows.canvas.navigation')}
			onPointerDown={begin}
			onPointerMove={move}
			onPointerUp={(event: PointerEvent) => finish(event)}
			onPointerCancel={(event: PointerEvent) => finish(event, true)}
			onLostPointerCapture={(event: PointerEvent) => {
				if (gesture.current) finish(event, true);
			}}
			onClick={(event: MouseEvent) => {
				if (suppressClick.current) {
					suppressClick.current = false;
					return;
				}
				if (
					!(event.target as Element).closest('.workflow-node,.workflow-edge')
				) {
					if (props.editable && props.connectionSource) props.onCreateConnected(
						snapPoint(canvasPoint(localPoint(event), viewRef.current)),
						props.connectionSource,
						localPoint(event),
					);
					props.onSelectNode('');
					props.onSelectEdge('');
				}
			}}
			onKeyDown={(event: KeyboardEvent) => {
				if (event.key === 'Escape') {
					gestureCleanup();
					props.onCancelConnection();
					return;
				}
				if (event.target !== event.currentTarget) return;
				if (event.key === '+' || event.key === '=') {
					event.preventDefault();
					zoom(1.2);
				}
				if (event.key === '-') {
					event.preventDefault();
					zoom(1 / 1.2);
				}
				if (event.key === '0') {
					event.preventDefault();
					fit();
				}
				const delta: Record<string, CanvasPoint> = {
					ArrowLeft: { x: 50, y: 0 },
					ArrowRight: { x: -50, y: 0 },
					ArrowUp: { x: 0, y: 50 },
					ArrowDown: { x: 0, y: -50 },
				};
				const offset = delta[event.key];
				if (offset) {
					event.preventDefault();
					setView({ ...view, x: view.x + offset.x, y: view.y + offset.y });
				}
			}}
		>
			<div
				class="workflow-canvas__stage"
				style={`transform: translate(${view.x}px, ${view.y}px) scale(${view.zoom});`}
			>
				<svg class="workflow-canvas__edges">
					@for (const entry of edges; key entry.edge.id) {
						<path
							class={[
								'workflow-edge',
								'workflow-edge--' + portTone(entry.edge.source.port),
								props.selectedEdgeId === entry.edge.id && 'is-selected',
								entry.state && `is-${entry.state}`,
							]}
							d={entry.path}
							role="button"
							tabindex={0}
							aria-label={t('workflows.canvas.editConnection', {
								source: entry.edge.source.nodeId,
								target: entry.edge.target.nodeId,
							})}
							onClick={(event: MouseEvent) => {
								event.stopPropagation();
								props.onSelectEdge(entry.edge.id);
							}}
							onKeyDown={(event: KeyboardEvent) => {
								if (
									props.editable &&
										(event.key === 'Delete' || event.key === 'Backspace')
								) {
									event.preventDefault();
									event.stopPropagation();
									props.onRemoveEdge(entry.edge.id);
								}
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									event.stopPropagation();
									props.onSelectEdge(entry.edge.id);
								}
							}}
						/>
					}
					@if (preview) {
						<path
							class={[
								'workflow-edge',
								'workflow-edge--preview',
								'workflow-edge--' + portTone(preview.port),
							]}
							d={connectionPath(preview.start, preview.end)}
						/>
					}
				</svg>
				@for (const node of props.graph.nodes; key node.id) {
					<WorkflowNodeCard
						node={node}
						position={positionOf(node.id)}
						selected={props.selectedNodeId === node.id}
						sourcePort={props.connectionSource?.nodeId === node.id
							? props.connectionSource.port
							: ''}
						targetPort={preview?.targetId === node.id ? preview.targetPort : ''}
						targetValid={preview?.valid ?? false}
						status={props.overlay?.nodes[node.id] ?? null}
						editable={props.editable}
						onSelect={() => {
							if (suppressClick.current) {
								suppressClick.current = false;
								return;
							}
							props.onSelectNode(node.id);
						}}
						onStartConnection={(port) => props.onStartConnection(node.id, port)}
						onFinishConnection={(port) => props.onFinishConnection(
							node.id,
							port,
						)}
						onMove={(x, y) => props.onMoveNode(node.id, x, y)}
					/>
				}
			</div>
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
