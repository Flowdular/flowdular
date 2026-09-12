import { MAX_PAGE_LIMIT } from '../pagination.ts';
import { csvRecord } from './csv.ts';

/**
 * The declaration a list endpoint makes so the platform can export it. It adds
 * nothing to the endpoint: the same `page` a keyset list already implements,
 * plus the columns a file needs headers for.
 *
 * The declaration is type-erased at definition time, so a registry holds many
 * lists of different row types and no row object ever leaves the module that
 * produced it.
 */

export const LIST_EXPORT_LIMITS = {
	id: 96,
	label: 120,
	permission: 96,
	columnKey: 64,
	header: 120,
	/** Columns one export declares. A wider file is a report, not a list. */
	columns: 64,
	/** Characters one cell may serialize to; over it the export is refused. */
	cell: 32_768,
} as const;

/** A dotted id: the module id followed by the key of the list it exports. */
const EXPORT_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const PERMISSION = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const COLUMN_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

export type ListExportErrorCode =
	/** The declaration is malformed; the module that wrote it is at fault. */
	| 'EXPORT_DEFINITION_INVALID'
	/** The list's own `page` or a column's `value` raised. */
	| 'EXPORT_LIST_FAILED'
	/** A page answered more rows than it was asked for. */
	| 'EXPORT_PAGE_OVERSIZE'
	/** A page carried a next cursor without advancing the walk. */
	| 'EXPORT_LIST_STALLED'
	| 'EXPORT_CELL_INVALID'
	| 'EXPORT_CELL_TOO_LARGE'
	| 'EXPORT_ROWS_EXCEEDED'
	| 'EXPORT_BYTES_EXCEEDED';

export class ListExportError extends Error {
	readonly code: ListExportErrorCode;

	constructor(
		code: ListExportErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'ListExportError';
		this.code = code;
	}
}

/** What a column may answer. Anything else is a defect in the declaration. */
export type ListExportCell =
	| string
	| number
	| boolean
	| Date
	| null
	| undefined;

export interface ListExportColumn<Row> {
	/** Stable within the export; a screen may name a column by it. */
	readonly key: string;
	/** The header text of the CSV column, written as the reader sees it. */
	readonly header: string;
	value(row: Row): ListExportCell;
}

export interface ListExportPage<Row> {
	readonly rows: readonly Row[];
	/** Null on the last page, exactly as the list endpoint answers it. */
	readonly nextCursor: string | null;
}

/**
 * What an export needs of the requester: who they are, whose workspace it is,
 * and what they held. It is structural, so a module hands in the principal it
 * already has and `packages/server` depends on no module to describe one.
 */
export interface ListExportPrincipal {
	readonly accountId: string;
	readonly tenantId: string;
	readonly scopes: readonly string[];
}

export interface ListExportDefinition<Row> {
	/** `<module id>.<list key>`, for example `users.core.members`. */
	readonly id: string;
	readonly label: string;
	/** The permission the list endpoint itself requires. */
	readonly permission: string;
	readonly columns: readonly ListExportColumn<Row>[];
	/**
	 * One page of the list, under this principal and this cursor. It is the
	 * `page` the list endpoint already implements: same order, same keyset, same
	 * tenant predicate. A page that answers a next cursor answers at least one
	 * row with it, so a walk over the list always ends.
	 */
	page(
		principal: ListExportPrincipal,
		cursor: string | null,
		limit: number,
	): Promise<ListExportPage<Row>>;
}

export interface ListExportColumnView {
	readonly key: string;
	readonly header: string;
}

export interface ListExportRecordPage {
	/** One CSV record per row, already serialized in column order. */
	readonly records: readonly string[];
	readonly rows: number;
	readonly nextCursor: string | null;
}

/** A declaration with its row type erased, as a registry and a job hold it. */
export interface DefinedListExport {
	readonly id: string;
	readonly label: string;
	readonly permission: string;
	readonly columns: readonly ListExportColumnView[];
	/** The header record, terminated, ready to be written first. */
	readonly header: string;
	page(
		principal: ListExportPrincipal,
		cursor: string | null,
		limit: number,
	): Promise<ListExportRecordPage>;
}

function bounded(value: unknown, label: string, max: number): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > max) {
		throw new ListExportError(
			'EXPORT_DEFINITION_INVALID',
			`A list export ${label} must be 1 to ${max} characters.`,
		);
	}
	return value;
}

/**
 * One cell as CSV text. A value the declaration cannot mean is refused rather
 * than written as an empty field: a silent blank in a hundred thousand rows is
 * a defect nobody finds, and a stable code names the column that produced it.
 */
export function listExportCell(value: ListExportCell, column: string): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new ListExportError(
				'EXPORT_CELL_INVALID',
				`The column ${column} answered a number a file cannot carry.`,
			);
		}
		return String(value);
	}
	if (value instanceof Date) {
		if (!Number.isFinite(value.getTime())) {
			throw new ListExportError(
				'EXPORT_CELL_INVALID',
				`The column ${column} answered an invalid date.`,
			);
		}
		return value.toISOString();
	}
	throw new ListExportError(
		'EXPORT_CELL_INVALID',
		`The column ${column} answered a value that is not exportable.`,
	);
}

/**
 * Declares a list export and erases its row type. Every bound the declaration
 * itself can break is checked here, while the platform composes, so a module
 * defect surfaces at boot rather than in the first job a workspace starts.
 */
export function defineListExport<Row>(
	definition: ListExportDefinition<Row>,
): DefinedListExport {
	const id = bounded(definition.id, 'id', LIST_EXPORT_LIMITS.id);
	if (!EXPORT_ID.test(id)) {
		throw new ListExportError(
			'EXPORT_DEFINITION_INVALID',
			`The list export id ${id} must match ${EXPORT_ID.source}.`,
		);
	}
	const label = bounded(definition.label, 'label', LIST_EXPORT_LIMITS.label);
	const permission = bounded(
		definition.permission,
		'permission',
		LIST_EXPORT_LIMITS.permission,
	);
	if (!PERMISSION.test(permission)) {
		throw new ListExportError(
			'EXPORT_DEFINITION_INVALID',
			`The list export ${id} declares a permission that is not a permission id.`,
		);
	}
	const declared = definition.columns;
	if (
		!Array.isArray(declared) ||
		declared.length === 0 ||
		declared.length > LIST_EXPORT_LIMITS.columns
	) {
		throw new ListExportError(
			'EXPORT_DEFINITION_INVALID',
			`The list export ${id} declares 1 to ${LIST_EXPORT_LIMITS.columns} columns.`,
		);
	}
	const keys = new Set<string>();
	const columns: ListExportColumnView[] = [];
	for (const column of declared) {
		const key = bounded(column.key, 'column key', LIST_EXPORT_LIMITS.columnKey);
		if (!COLUMN_KEY.test(key)) {
			throw new ListExportError(
				'EXPORT_DEFINITION_INVALID',
				`The column key ${key} must match ${COLUMN_KEY.source}.`,
			);
		}
		if (keys.has(key)) {
			throw new ListExportError(
				'EXPORT_DEFINITION_INVALID',
				`The list export ${id} declares the column ${key} twice.`,
			);
		}
		keys.add(key);
		if (typeof column.value !== 'function') {
			throw new ListExportError(
				'EXPORT_DEFINITION_INVALID',
				`The column ${key} declares no value function.`,
			);
		}
		columns.push({
			key,
			header: bounded(
				column.header,
				'column header',
				LIST_EXPORT_LIMITS.header,
			),
		});
	}
	if (typeof definition.page !== 'function') {
		throw new ListExportError(
			'EXPORT_DEFINITION_INVALID',
			`The list export ${id} declares no page function.`,
		);
	}
	/* Held once: the declaration is frozen at composition and every later page
	   reads the same array, so a job allocates no column list per page. */
	const values = declared.map((column) => column.value);
	const keyed = columns.map((column) => column.key);
	const cells: string[] = new Array(columns.length);

	const page = async (
		principal: ListExportPrincipal,
		cursor: string | null,
		limit: number,
	): Promise<ListExportRecordPage> => {
		/* The list belongs to another module. A page that raises is that module's
		   defect and must reach the job as one stable code, never as a foreign
		   error shape the job would record verbatim. */
		let answered: ListExportPage<Row>;
		try {
			answered = await definition.page(principal, cursor, limit);
		} catch (error) {
			if (error instanceof ListExportError) throw error;
			throw new ListExportError(
				'EXPORT_LIST_FAILED',
				`The list ${id} could not answer a page.`,
				{ cause: error },
			);
		}
		const rows = answered?.rows;
		const nextCursor = answered?.nextCursor ?? null;
		if (!Array.isArray(rows)) {
			throw new ListExportError(
				'EXPORT_LIST_FAILED',
				`The list ${id} answered a page without rows.`,
			);
		}
		if (rows.length > limit) {
			throw new ListExportError(
				'EXPORT_PAGE_OVERSIZE',
				`The list ${id} answered ${rows.length} rows for a page of ${limit}.`,
			);
		}
		/* Two ways a walk could never end, both refused here rather than bounded
		   by a page counter nobody could explain: a cursor that does not move, and
		   an empty page that still promises more. */
		if (nextCursor !== null && (nextCursor === cursor || rows.length === 0)) {
			throw new ListExportError(
				'EXPORT_LIST_STALLED',
				`The list ${id} answered a next cursor without advancing.`,
			);
		}
		const records: string[] = new Array(rows.length);
		let column = '';
		try {
			for (let row = 0; row < rows.length; row += 1) {
				for (let index = 0; index < values.length; index += 1) {
					column = keyed[index]!;
					const cell = listExportCell(values[index]!(rows[row]!), column);
					if (cell.length > LIST_EXPORT_LIMITS.cell) {
						throw new ListExportError(
							'EXPORT_CELL_TOO_LARGE',
							`The column ${column} answered more than ${LIST_EXPORT_LIMITS.cell} characters.`,
						);
					}
					cells[index] = cell;
				}
				records[row] = csvRecord(cells);
			}
		} catch (error) {
			if (error instanceof ListExportError) throw error;
			throw new ListExportError(
				'EXPORT_LIST_FAILED',
				`The column ${column} of ${id} could not read a row.`,
				{ cause: error },
			);
		}
		return { records, rows: rows.length, nextCursor };
	};

	return Object.freeze({
		id,
		label,
		permission,
		columns: Object.freeze(columns),
		header: csvRecord(columns.map((entry) => entry.header)),
		page,
	});
}

/** Rows one page of an export asks for: the platform list ceiling. */
export const LIST_EXPORT_PAGE_LIMIT = MAX_PAGE_LIMIT;
