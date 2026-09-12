import {
	CONNECTOR_AUTH_KINDS,
	CONNECTOR_METHODS,
	type ConnectorDefinition,
	type ConnectorOperation,
} from './types.ts';

/**
 * The registry a module obtains with `context.capabilities.get` to ship its own
 * connector kind. Registration happens while modules compose; the first read
 * seals the registry, so the set a workspace sees cannot change under a call.
 */
export const CONNECTORS_DEFINITIONS_CAPABILITY = 'connectors.definitions.v1';

export interface ConnectorDefinitionRegistry {
	register(definition: ConnectorDefinition): void;
	list(): readonly ConnectorDefinition[];
	get(key: string): ConnectorDefinition | null;
}

/** Definitions are code, not tenant data, so the bound is a boot-time bug guard. */
export const MAX_DEFINITIONS = 64;
export const MAX_OPERATIONS_PER_DEFINITION = 64;
export const MAX_PORTS_PER_DEFINITION = 8;

/** The one port every connector reaches unless its definition names more. */
export const DEFAULT_ALLOWED_PORTS: readonly number[] = Object.freeze([443]);

/** The ports an instance of this definition may reach, defaulted. */
export function definitionAllowedPorts(
	definition: ConnectorDefinition,
): readonly number[] {
	return definition.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
}

export class ConnectorDefinitionError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'ConnectorDefinitionError';
	}
}

function identifier(value: string, field: string, max: number): string {
	if (!new RegExp(`^[a-z][a-z0-9-]{0,${max - 1}}$`).test(value)) {
		throw new ConnectorDefinitionError(
			'DEFINITION_INVALID',
			`${field} must be a lowercase identifier of at most ${max} characters.`,
		);
	}
	return value;
}

function text(value: string, field: string, max: number): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.length > max) {
		throw new ConnectorDefinitionError(
			'DEFINITION_INVALID',
			`${field} must contain between 1 and ${max} characters.`,
		);
	}
	return normalized;
}

function operation(value: ConnectorOperation): ConnectorOperation {
	identifier(value.key, 'operation key', 64);
	text(value.label, 'operation label', 120);
	if (!CONNECTOR_METHODS.includes(value.method)) {
		throw new ConnectorDefinitionError(
			'DEFINITION_INVALID',
			`operation ${value.key} declares an unsupported method.`,
		);
	}
	const path = text(value.path, 'operation path', 1_024);
	/* The expanded path is always absolute: either the template starts with the
	   slash, or it opens with a reserved expansion whose value must. */
	if (!path.startsWith('/') && !path.startsWith('{+')) {
		throw new ConnectorDefinitionError(
			'DEFINITION_INVALID',
			`operation ${value.key} must declare a path template that expands to an absolute path.`,
		);
	}
	return value;
}

export function assertConnectorDefinition(
	definition: ConnectorDefinition,
): ConnectorDefinition {
	identifier(definition.key, 'definition key', 96);
	text(definition.moduleId, 'definition moduleId', 64);
	text(definition.label, 'definition label', 120);
	if (definition.authKinds.length === 0) {
		throw new ConnectorDefinitionError(
			'DEFINITION_INVALID',
			`definition ${definition.key} must support at least one authentication kind.`,
		);
	}
	for (const kind of definition.authKinds) {
		if (!CONNECTOR_AUTH_KINDS.includes(kind)) {
			throw new ConnectorDefinitionError(
				'DEFINITION_INVALID',
				`definition ${definition.key} declares an unknown authentication kind.`,
			);
		}
	}
	if (
		definition.operations.length === 0 ||
		definition.operations.length > MAX_OPERATIONS_PER_DEFINITION
	) {
		throw new ConnectorDefinitionError(
			'DEFINITION_INVALID',
			`definition ${definition.key} must declare between 1 and ${MAX_OPERATIONS_PER_DEFINITION} operations.`,
		);
	}
	const keys = new Set<string>();
	for (const item of definition.operations) {
		operation(item);
		if (keys.has(item.key)) {
			throw new ConnectorDefinitionError(
				'DEFINITION_INVALID',
				`definition ${definition.key} declares operation ${item.key} twice.`,
			);
		}
		keys.add(item.key);
	}
	for (const host of definition.defaultAllowedHosts) {
		text(host, 'definition host', 253);
	}
	if (definition.allowedPorts !== undefined) {
		if (
			definition.allowedPorts.length === 0 ||
			definition.allowedPorts.length > MAX_PORTS_PER_DEFINITION
		) {
			throw new ConnectorDefinitionError(
				'DEFINITION_INVALID',
				`definition ${definition.key} must declare between 1 and ${MAX_PORTS_PER_DEFINITION} allowed ports, or none at all.`,
			);
		}
		for (const port of definition.allowedPorts) {
			if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
				throw new ConnectorDefinitionError(
					'DEFINITION_INVALID',
					`definition ${definition.key} declares ${String(port)}, which is not a port.`,
				);
			}
		}
	}
	return definition;
}

export function createConnectorDefinitionRegistry(): ConnectorDefinitionRegistry {
	const definitions = new Map<string, ConnectorDefinition>();
	let sealed = false;
	return {
		register(definition) {
			if (sealed) {
				throw new ConnectorDefinitionError(
					'DEFINITIONS_SEALED',
					'Connector definitions are registered while modules compose, not afterwards.',
				);
			}
			assertConnectorDefinition(definition);
			if (definitions.has(definition.key)) {
				throw new ConnectorDefinitionError(
					'DEFINITION_DUPLICATE',
					`A connector definition with key ${definition.key} is already registered.`,
				);
			}
			if (definitions.size >= MAX_DEFINITIONS) {
				throw new ConnectorDefinitionError(
					'DEFINITIONS_EXHAUSTED',
					`At most ${MAX_DEFINITIONS} connector definitions may be registered.`,
				);
			}
			definitions.set(definition.key, Object.freeze({ ...definition }));
		},
		list() {
			sealed = true;
			return [...definitions.values()].sort((left, right) =>
				left.key.localeCompare(right.key),
			);
		},
		get(key) {
			sealed = true;
			return definitions.get(key) ?? null;
		},
	};
}
