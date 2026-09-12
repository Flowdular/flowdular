import type { DefinedListExport } from '@flowdular/server';
import { EXPORT_LIST_LIMITS, type ExportLists } from '../domain/lists.ts';

export class ExportListError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'ExportListError';
	}
}

/** A registered list and the module that declared it. */
export interface RegisteredExportList {
	readonly id: string;
	readonly moduleId: string;
	readonly definition: DefinedListExport;
}

export interface ExportListRegistry extends ExportLists {
	/** Closes registration. Every later `register` throws. */
	seal(): void;
	find(id: string): RegisteredExportList | null;
	list(): readonly RegisteredExportList[];
}

/**
 * The lists a workspace can export. Registration is open while the platform
 * composes and sealed before the first request, so the catalogue a job was
 * started against cannot change under it. Lookup is a map read, O(1).
 */
export function createExportListRegistry(): ExportListRegistry {
	const lists = new Map<string, RegisteredExportList>();
	let sealed = false;
	return {
		register(moduleId, registered) {
			if (sealed) {
				throw new ExportListError(
					'EXPORT_LISTS_SEALED',
					'List exports are registered while the platform composes.',
					500,
				);
			}
			if (
				typeof moduleId !== 'string' ||
				moduleId.length === 0 ||
				moduleId.length > EXPORT_LIST_LIMITS.moduleId
			) {
				throw new ExportListError(
					'EXPORT_LIST_INVALID',
					`A module id is 1 to ${EXPORT_LIST_LIMITS.moduleId} characters.`,
					500,
				);
			}
			if (registered.length > EXPORT_LIST_LIMITS.listsPerModule) {
				throw new ExportListError(
					'EXPORT_LIST_INVALID',
					`A module registers at most ${EXPORT_LIST_LIMITS.listsPerModule} lists.`,
					500,
				);
			}
			for (const definition of registered) {
				/* The id is the registrar's own namespace. Without this a module
				   could declare an export under another module's id and answer for a
				   list it does not own. */
				if (!definition.id.startsWith(`${moduleId}.`)) {
					throw new ExportListError(
						'EXPORT_LIST_INVALID',
						`The list ${definition.id} is not inside the namespace of ${moduleId}.`,
						500,
					);
				}
				if (lists.has(definition.id)) {
					throw new ExportListError(
						'EXPORT_LIST_DUPLICATE',
						`The list export ${definition.id} is already registered.`,
						500,
					);
				}
				if (lists.size >= EXPORT_LIST_LIMITS.lists) {
					throw new ExportListError(
						'EXPORT_LIST_INVALID',
						`The catalogue holds at most ${EXPORT_LIST_LIMITS.lists} lists.`,
						500,
					);
				}
				lists.set(definition.id, {
					id: definition.id,
					moduleId,
					definition,
				});
			}
		},
		seal() {
			sealed = true;
		},
		find: (id) => lists.get(id) ?? null,
		list: () =>
			[...lists.values()].sort((left, right) =>
				left.id.localeCompare(right.id),
			),
	};
}
