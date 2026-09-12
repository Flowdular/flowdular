import type { DefinedListExport } from '@flowdular/server';

/**
 * The public cross-module surface. A module that owns a list registers it while
 * it composes:
 * `context.capabilities.get<ExportLists>(EXPORT_LISTS_CAPABILITY)?.register('users.core', [members])`.
 *
 * exports.core never reads another module's database. It walks the list through
 * the `page` the list endpoint already implements, under the requester the job
 * was started by, and writes what comes back.
 */
export const EXPORT_LISTS_CAPABILITY = 'exports.lists.v1';

export interface ExportLists {
	/**
	 * Registers the lists one module owns. Every id must be that module id
	 * followed by the list key, so a module can only declare its own exports.
	 * Open while the platform composes and sealed before the first request.
	 */
	register(moduleId: string, exports: readonly DefinedListExport[]): void;
}

export const EXPORT_LIST_LIMITS = {
	moduleId: 64,
	/** Lists one module may register. */
	listsPerModule: 32,
	/** Lists the catalogue may hold at all. */
	lists: 256,
} as const;
