/* Tools a module offers to agent runs. Modules register during composition;
   the agent runtime reads the list when it starts, after every module ran. */
import { RegistryError } from './errors.ts';

export interface PlatformToolRegistry<T = unknown, N = unknown> {
	register(tools: readonly T[]): void;
	list(): readonly T[];
	/* A tool the model provider executes itself, such as a web search. It
	   shares the id space of `register`, because a run grants both by id. */
	registerNative(tool: N): void;
	listNative(): readonly N[];
}

/* Only the flowdular markers protect a field: workflows and agents read no other
   vendor's secret or read-permission key, so a field marked with one would be
   bound into graphs and returned unredacted. Registration refuses it instead. */
const VENDOR_MARKER = /^x-.+-(?:secret|read-permission)$/i;
const KNOWN_MARKERS = new Set([
	'x-flowdular-secret',
	'x-flowdular-read-permission',
]);
/* Keys under these keywords are field names, and their values are schemas. */
const SCHEMA_NAME_MAPS = new Set([
	'properties',
	'patternProperties',
	'$defs',
	'definitions',
	'dependentSchemas',
]);
/* Instance data, never read as a marker. */
const SCHEMA_DATA_KEYS = new Set([
	'default',
	'const',
	'enum',
	'example',
	'examples',
]);

function unknownMarker(value: unknown, seen: Set<object>): string | null {
	if (value === null || typeof value !== 'object' || seen.has(value))
		return null;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const entry of value) {
			const found = unknownMarker(entry, seen);
			if (found) return found;
		}
		return null;
	}
	for (const [key, child] of Object.entries(value)) {
		if (VENDOR_MARKER.test(key) && !KNOWN_MARKERS.has(key)) return key;
		if (SCHEMA_DATA_KEYS.has(key)) continue;
		const schemas =
			SCHEMA_NAME_MAPS.has(key) &&
			child !== null &&
			typeof child === 'object' &&
			!Array.isArray(child)
				? Object.values(child)
				: [child];
		for (const schema of schemas) {
			const found = unknownMarker(schema, seen);
			if (found) return found;
		}
	}
	return null;
}

function assertKnownMarkers(tool: { readonly id: string }): void {
	const { inputSchema, outputSchema } = tool as {
		readonly inputSchema?: unknown;
		readonly outputSchema?: unknown;
	};
	const marker = unknownMarker([inputSchema, outputSchema], new Set());
	if (marker)
		throw new RegistryError(
			'AGENT_TOOL_SCHEMA_MARKER_UNKNOWN',
			`Agent tool ${tool.id} marks a schema field with ${marker}; only x-flowdular-secret and x-flowdular-read-permission protect a field.`,
		);
}

export function createPlatformToolRegistry<
	T extends { readonly id: string },
	N extends { readonly id: string } = { readonly id: string },
>(): PlatformToolRegistry<T, N> {
	const tools = new Map<string, T>();
	const nativeTools = new Map<string, N>();
	return {
		register(entries) {
			for (const tool of entries) {
				if (tools.has(tool.id) || nativeTools.has(tool.id)) {
					throw new RegistryError(
						'AGENT_TOOL_DUPLICATE',
						`Agent tool ${tool.id} is already registered.`,
					);
				}
				assertKnownMarkers(tool);
				tools.set(tool.id, tool);
			}
		},
		list() {
			return [...tools.values()];
		},
		registerNative(tool) {
			if (tools.has(tool.id) || nativeTools.has(tool.id)) {
				throw new RegistryError(
					'AGENT_TOOL_DUPLICATE',
					`Agent tool ${tool.id} is already registered.`,
				);
			}
			nativeTools.set(tool.id, tool);
		},
		listNative() {
			return [...nativeTools.values()];
		},
	};
}
