/**
 * A CSV export of any list endpoint that already pages with the keyset helpers
 * (`docs/rfc/0004-platform-services.md`, H4).
 *
 * What lives here: the declaration a list makes, its bounds, the RFC 4180
 * writer and the walk that turns pages into a file. It opens no database, no
 * storage and no job table, so a module can declare an export and a test can
 * run one without either.
 *
 * What a module keeps: the list itself. `page` is the one the list endpoint
 * already implements, called with the same cursor contract, so an export can
 * never see a row the endpoint would not have returned.
 *
 * What `exports.core` keeps: the job table, the endpoints, the poll loop, the
 * storage object and the read URL. It is the only registrar of these
 * declarations, through its public capability `exports.lists.v1`.
 *
 * Declaring one, from the module that owns the list:
 *
 * ```ts
 * const members = defineListExport<Member>({
 * 	id: 'users.core.members',
 * 	label: 'Members',
 * 	permission: USERS_PERMISSIONS.read,
 * 	columns: [
 * 		{ key: 'email', header: 'E-mail', value: (row) => row.email },
 * 		{ key: 'joinedAt', header: 'Joined', value: (row) => row.joinedAt },
 * 	],
 * 	page: (principal, cursor, limit) =>
 * 		service.members(principal.tenantId, { cursor, limit }),
 * });
 * context.capabilities
 * 	.get<ExportLists>(EXPORT_LISTS_CAPABILITY)
 * 	?.register('users.core', [members]);
 * ```
 */
export { CSV_BOM, CSV_RECORD_SEPARATOR, csvField, csvRecord } from './csv.ts';
export {
	defineListExport,
	listExportCell,
	ListExportError,
	LIST_EXPORT_LIMITS,
	LIST_EXPORT_PAGE_LIMIT,
} from './definition.ts';
export type {
	DefinedListExport,
	ListExportCell,
	ListExportColumn,
	ListExportColumnView,
	ListExportDefinition,
	ListExportErrorCode,
	ListExportPage,
	ListExportPrincipal,
	ListExportRecordPage,
} from './definition.ts';
export { runListExport } from './run.ts';
export type {
	ListExportBounds,
	ListExportResult,
	ListExportRunOptions,
} from './run.ts';
