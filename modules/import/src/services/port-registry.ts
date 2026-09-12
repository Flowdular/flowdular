import {
	IMPORT_FIELD_TYPES,
	IMPORT_PORT_LIMITS,
	importTargetId,
	type ImportPort,
	type ImportPorts,
} from '../domain/ports.ts';

export class ImportPortError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'ImportPortError';
	}
}

/** A target and the module that registered it, resolved by target id. */
export interface RegisteredImportPort {
	readonly target: string;
	readonly moduleId: string;
	readonly port: ImportPort;
}

export interface ImportPortRegistry extends ImportPorts {
	/** Closes registration. Every later `register` throws. */
	seal(): void;
	find(target: string): RegisteredImportPort | null;
	list(): readonly RegisteredImportPort[];
}

function bounded(value: string, label: string, max: number): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > max) {
		throw new ImportPortError(
			'IMPORT_PORT_INVALID',
			`An import port ${label} must be 1 to ${max} characters.`,
			500,
		);
	}
	return value;
}

function assertPort(moduleId: string, port: ImportPort): void {
	bounded(port.key, 'key', IMPORT_PORT_LIMITS.key);
	bounded(port.label, 'label', IMPORT_PORT_LIMITS.label);
	bounded(port.permission, 'permission', IMPORT_PORT_LIMITS.permission);
	if (
		port.fields.length === 0 ||
		port.fields.length > IMPORT_PORT_LIMITS.fields
	) {
		throw new ImportPortError(
			'IMPORT_PORT_INVALID',
			`An import port declares 1 to ${IMPORT_PORT_LIMITS.fields} fields.`,
			500,
		);
	}
	const ids = new Set<string>();
	for (const field of port.fields) {
		bounded(field.id, 'field id', IMPORT_PORT_LIMITS.fieldId);
		bounded(field.label, 'field label', IMPORT_PORT_LIMITS.fieldLabel);
		if (!(IMPORT_FIELD_TYPES as readonly string[]).includes(field.type)) {
			throw new ImportPortError(
				'IMPORT_PORT_INVALID',
				`The field ${field.id} declares an unknown type.`,
				500,
			);
		}
		if (ids.has(field.id)) {
			throw new ImportPortError(
				'IMPORT_PORT_INVALID',
				`The field ${field.id} is declared twice.`,
				500,
			);
		}
		ids.add(field.id);
	}
	if (
		port.naturalKey.length === 0 ||
		port.naturalKey.length > IMPORT_PORT_LIMITS.naturalKey
	) {
		throw new ImportPortError(
			'IMPORT_PORT_INVALID',
			'An import port declares a natural key of 1 to ' +
				`${IMPORT_PORT_LIMITS.naturalKey} fields.`,
			500,
		);
	}
	/* A natural key naming a field the port does not accept can never make a
	   repeat idempotent, so it is refused where it is declared rather than
	   discovered on the second import. */
	for (const field of port.naturalKey) {
		if (!ids.has(field)) {
			throw new ImportPortError(
				'IMPORT_PORT_INVALID',
				`The natural key names ${field}, which is not a declared field.`,
				500,
			);
		}
	}
	if (importTargetId(moduleId, port.key).length > IMPORT_PORT_LIMITS.target) {
		throw new ImportPortError(
			'IMPORT_PORT_INVALID',
			`The target id is longer than ${IMPORT_PORT_LIMITS.target} characters.`,
			500,
		);
	}
}

/**
 * The targets a workspace can import into. Registration is open while the
 * platform composes and sealed before the first request, so the target list a
 * job was started against cannot change under it. Lookup is a map read, O(1).
 */
export function createImportPortRegistry(): ImportPortRegistry {
	const ports = new Map<string, RegisteredImportPort>();
	let sealed = false;
	return {
		register(moduleId, registered) {
			if (sealed) {
				throw new ImportPortError(
					'IMPORT_PORTS_SEALED',
					'Import ports are registered while the platform composes.',
					500,
				);
			}
			bounded(moduleId, 'module id', IMPORT_PORT_LIMITS.moduleId);
			if (registered.length > IMPORT_PORT_LIMITS.portsPerModule) {
				throw new ImportPortError(
					'IMPORT_PORT_INVALID',
					`A module registers at most ${IMPORT_PORT_LIMITS.portsPerModule} ports.`,
					500,
				);
			}
			for (const port of registered) {
				assertPort(moduleId, port);
				const target = importTargetId(moduleId, port.key);
				if (ports.has(target)) {
					throw new ImportPortError(
						'IMPORT_PORT_DUPLICATE',
						`The import target ${target} is already registered.`,
						500,
					);
				}
				ports.set(target, { target, moduleId, port });
			}
		},
		seal() {
			sealed = true;
		},
		find: (target) => ports.get(target) ?? null,
		list: () =>
			[...ports.values()].sort((left, right) =>
				left.target.localeCompare(right.target),
			),
	};
}
