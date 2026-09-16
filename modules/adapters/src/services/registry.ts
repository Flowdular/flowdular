import { parseCron } from '../domain/cron.ts';
import { AdapterMappingError, readMapping } from '../domain/mapping.ts';
import { jsonSize, validPath } from '../domain/paths.ts';
import {
	ADAPTER_IMPORT_MODES,
	type AdapterDirection,
	type AdapterRecordedFixture,
	type AdapterRegistration,
	type AdapterRegistry,
} from '../domain/registry.ts';
import { ADAPTER_LIMITS } from '../domain/types.ts';

export class AdapterRegistryError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 500,
	) {
		super(message);
		this.name = 'AdapterRegistryError';
	}
}

/** An adapter and the module that registered it, with the registration checked. */
export interface RegisteredAdapter {
	readonly moduleId: string;
	readonly registration: AdapterRegistration;
}

export interface AdapterCatalogue {
	readonly sources: AdapterRegistry;
	readonly sinks: AdapterRegistry;
	/** Closes registration; every later `register` throws. */
	seal(): void;
	find(id: string): RegisteredAdapter | null;
	list(): readonly RegisteredAdapter[];
}

const DOTTED_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const CONNECTOR = /^[a-z][a-z0-9-]{0,95}$/;
const OPERATION = /^[a-z][a-z0-9-]{0,63}$/;

function refuse(id: string, reason: string): AdapterRegistryError {
	return new AdapterRegistryError(
		'ADAPTER_REGISTRATION_INVALID',
		`The adapter ${id} cannot be registered: ${reason}`,
	);
}

function plainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recorded(
	id: string,
	operation: string,
	fixture: unknown,
): AdapterRecordedFixture {
	if (
		!plainObject(fixture) ||
		fixture['adapter'] !== id ||
		fixture['operation'] !== operation
	) {
		throw refuse(
			id,
			'the recorded fixture names another adapter or operation.',
		);
	}
	const calls = fixture['calls'];
	if (
		!Array.isArray(calls) ||
		calls.length === 0 ||
		calls.length > ADAPTER_LIMITS.recordedCalls ||
		!calls.every((call) => plainObject(call) && plainObject(call['input']))
	) {
		throw refuse(
			id,
			`the recorded fixture needs 1 to ${ADAPTER_LIMITS.recordedCalls} calls with an input object.`,
		);
	}
	const size = jsonSize(fixture);
	if (size === null || size > ADAPTER_LIMITS.recordedJson) {
		throw refuse(id, 'the recorded fixture is not JSON of at most 1 MB.');
	}
	return fixture as unknown as AdapterRecordedFixture;
}

/**
 * Every rule a registration can break without knowing the port or the list,
 * checked where the module registers, so a defect surfaces at boot. Answers
 * the registration with its mapping read into plain rules.
 */
function checked(
	moduleId: string,
	direction: AdapterDirection,
	entry: AdapterRegistration,
): AdapterRegistration {
	const id = typeof entry?.id === 'string' ? entry.id : '';
	if (
		id.length > ADAPTER_LIMITS.id ||
		!DOTTED_ID.test(id) ||
		!id.startsWith(`${moduleId}.`)
	) {
		throw refuse(id || '(unnamed)', `the id is not inside ${moduleId}.`);
	}
	if (entry.direction !== direction) {
		throw refuse(id, `it is not a ${direction}.`);
	}
	if (
		typeof entry.label !== 'string' ||
		entry.label.trim() === '' ||
		entry.label.length > ADAPTER_LIMITS.label
	) {
		throw refuse(id, 'the label is not bounded text.');
	}
	if (!CONNECTOR.test(entry.connector ?? '')) {
		throw refuse(id, 'the connector is not a definition key.');
	}
	if (!OPERATION.test(entry.operation ?? '')) {
		throw refuse(id, 'the operation is not an operation key.');
	}
	const port = entry.port ?? '';
	if (port.length > ADAPTER_LIMITS.id || !DOTTED_ID.test(port)) {
		throw refuse(id, 'the port is not a dotted id.');
	}
	if (direction === 'sink' && !port.startsWith(`${moduleId}.`)) {
		throw refuse(id, `a sink pushes a list of ${moduleId} only.`);
	}
	if (entry.schedule !== undefined && entry.schedule !== null) {
		try {
			parseCron(entry.schedule);
		} catch {
			throw refuse(id, 'the schedule is not a five-field cron.');
		}
	}
	let mapping: AdapterRegistration['mapping'];
	try {
		mapping = readMapping(entry.mapping, direction);
	} catch (error) {
		if (error instanceof AdapterMappingError) throw refuse(id, error.message);
		throw error;
	}
	if (entry.input !== undefined) {
		const size = jsonSize(entry.input);
		if (
			!plainObject(entry.input) ||
			size === null ||
			size > ADAPTER_LIMITS.inputJson
		) {
			throw refuse(id, 'the input is not a JSON object of at most 8 KB.');
		}
	}
	if (
		entry.items !== undefined &&
		!validPath(entry.items, direction === 'source')
	) {
		throw refuse(id, 'the items path is invalid.');
	}
	if (direction === 'sink') {
		if (entry.items === undefined) {
			throw refuse(id, 'a sink names the input path of a batch in items.');
		}
		if (entry.paging !== undefined || entry.mode !== undefined) {
			throw refuse(id, 'paging and mode belong to a source.');
		}
		if (
			entry.batchSize !== undefined &&
			(!Number.isSafeInteger(entry.batchSize) ||
				entry.batchSize < 1 ||
				entry.batchSize > ADAPTER_LIMITS.sinkBatchMax)
		) {
			throw refuse(
				id,
				`the batch size is 1 to ${ADAPTER_LIMITS.sinkBatchMax}.`,
			);
		}
	} else {
		if (entry.batchSize !== undefined) {
			throw refuse(id, 'a batch size belongs to a sink.');
		}
		if (
			entry.mode !== undefined &&
			!(ADAPTER_IMPORT_MODES as readonly string[]).includes(entry.mode)
		) {
			throw refuse(id, 'the mode is unknown.');
		}
		const paging = entry.paging;
		if (paging !== undefined) {
			const valid =
				plainObject(paging) &&
				validPath(paging.param, false) &&
				((paging.kind === 'cursor' && validPath(paging.next, false)) ||
					(paging.kind === 'page' &&
						(paging.start === undefined ||
							(Number.isSafeInteger(paging.start) &&
								paging.start >= 0 &&
								paging.start <= 1_000_000))));
			if (!valid) throw refuse(id, 'the paging is invalid.');
		}
	}
	return {
		...entry,
		mapping,
		...(entry.recorded === undefined
			? {}
			: { recorded: recorded(id, entry.operation, entry.recorded) }),
	};
}

/**
 * The adapters a workspace can bind. Registration is open while the platform
 * composes and sealed when adapters.core starts, so the catalogue a run was
 * queued against cannot change under it. Lookup is a map read.
 */
export function createAdapterCatalogue(): AdapterCatalogue {
	const adapters = new Map<string, RegisteredAdapter>();
	let sealed = false;

	const registry = (direction: AdapterDirection): AdapterRegistry => ({
		register(moduleId, registrations) {
			if (sealed) {
				throw new AdapterRegistryError(
					'ADAPTER_REGISTRY_SEALED',
					'Adapters are registered while the platform composes.',
				);
			}
			if (
				typeof moduleId !== 'string' ||
				moduleId.length === 0 ||
				moduleId.length > ADAPTER_LIMITS.moduleId
			) {
				throw refuse('(unnamed)', 'the module id is not bounded text.');
			}
			if (
				!Array.isArray(registrations) ||
				registrations.length > ADAPTER_LIMITS.adaptersPerModule ||
				adapters.size + registrations.length > ADAPTER_LIMITS.adapters
			) {
				throw refuse(
					moduleId,
					`a module registers at most ${ADAPTER_LIMITS.adaptersPerModule} adapters.`,
				);
			}
			/* Every entry is checked before any is kept, so a refused call leaves
			   the catalogue as it was. */
			const accepted: RegisteredAdapter[] = [];
			const ids = new Set<string>();
			for (const entry of registrations) {
				const registration = checked(moduleId, direction, entry);
				if (adapters.has(registration.id) || ids.has(registration.id)) {
					throw refuse(registration.id, 'it is already registered.');
				}
				ids.add(registration.id);
				accepted.push({ moduleId, registration });
			}
			for (const registered of accepted) {
				adapters.set(registered.registration.id, registered);
			}
		},
	});

	return {
		sources: registry('source'),
		sinks: registry('sink'),
		seal() {
			sealed = true;
		},
		find: (id) => adapters.get(id) ?? null,
		list: () =>
			[...adapters.values()].sort((left, right) =>
				left.registration.id.localeCompare(right.registration.id),
			),
	};
}
