import type { WorkflowGraphV1 } from '../domain/types.ts';

export interface CanvasPoint {
	readonly x: number;
	readonly y: number;
}
export interface CanvasViewport extends CanvasPoint {
	readonly zoom: number;
}
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
export const CANVAS_GRID = 24;
export function snapPoint(point: CanvasPoint): CanvasPoint {
	return {
		x: Math.max(0, Math.round(point.x / CANVAS_GRID) * CANVAS_GRID),
		y: Math.max(0, Math.round(point.y / CANVAS_GRID) * CANVAS_GRID),
	};
}
export const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

export function canvasPoint(
	point: CanvasPoint,
	view: CanvasViewport,
): CanvasPoint {
	return {
		x: (point.x - view.x) / view.zoom,
		y: (point.y - view.y) / view.zoom,
	};
}

export function zoomCanvas(
	view: CanvasViewport,
	zoom: number,
	anchor: CanvasPoint,
): CanvasViewport {
	if (!Number.isFinite(zoom)) return view;
	const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
	const world = canvasPoint(anchor, view);
	return {
		x: anchor.x - world.x * next,
		y: anchor.y - world.y * next,
		zoom: next,
	};
}

export function draggedNode(
	origin: CanvasPoint,
	delta: CanvasPoint,
	zoom: number,
): CanvasPoint {
	return {
		x: Math.max(0, Math.round(origin.x + delta.x / zoom)),
		y: Math.max(0, Math.round(origin.y + delta.y / zoom)),
	};
}

/** O(nodes), independent of edge count. Extra height accommodates multi-port nodes. */
export function fitCanvas(
	graph: WorkflowGraphV1,
	width: number,
	height: number,
): CanvasViewport {
	if (!graph.nodes.length || width <= 0 || height <= 0) return DEFAULT_VIEWPORT;
	let left = Infinity,
		top = Infinity,
		right = -Infinity,
		bottom = -Infinity;
	for (const node of graph.nodes) {
		const point = graph.layout[node.id] ?? { x: 0, y: 0 };
		left = Math.min(left, point.x);
		top = Math.min(top, point.y);
		right = Math.max(right, point.x + 216);
		bottom = Math.max(
			bottom,
			point.y +
				96 +
				Math.max(node.inputPorts.length, node.outputPorts.length) * 32,
		);
	}
	const zoom = Math.min(
		1,
		Math.max(
			MIN_ZOOM,
			Math.min((width - 64) / (right - left), (height - 64) / (bottom - top)),
		),
	);
	return {
		zoom,
		x: (width - (right - left) * zoom) / 2 - left * zoom,
		y: (height - (bottom - top) * zoom) / 2 - top * zoom,
	};
}

export function connectionPath(
	source: CanvasPoint,
	target: CanvasPoint,
): string {
	if (target.x >= source.x + CANVAS_GRID * 2) {
		const middle =
			Math.round((source.x + target.x) / (2 * CANVAS_GRID)) * CANVAS_GRID;
		return `M ${source.x} ${source.y} H ${middle} V ${target.y} H ${target.x}`;
	}
	const corridor =
		Math.ceil(Math.max(source.y, target.y) / CANVAS_GRID) * CANVAS_GRID +
		CANVAS_GRID * 2;
	return `M ${source.x} ${source.y} H ${source.x + CANVAS_GRID} V ${corridor} H ${target.x - CANVAS_GRID} V ${target.y} H ${target.x}`;
}
