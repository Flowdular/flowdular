import type { AuthPrincipal } from '@flowdular/module-auth';

/**
 * The public cross-module surface. A module that owns records registers its own
 * import targets while it composes:
 * `context.capabilities.get<ImportPorts>(IMPORT_PORTS_CAPABILITY)?.register(...)`.
 *
 * import.core never writes another module's records. It parses the CSV, maps
 * the columns, checks the port's declared permission on the acting principal
 * and then hands bounded batches of rows to the port, which applies its own
 * invariants, its own natural key and its own tenant-scoped transaction.
 */
export const IMPORT_PORTS_CAPABILITY = 'import.ports.v1';

/**
 * What a field holds. The type is the port's declaration of shape, not its
 * validation: import.core refuses a cell that cannot be that type at all, and
 * the port still decides what a well-shaped value means.
 */
export const IMPORT_FIELD_TYPES = [
	'string',
	'integer',
	'boolean',
	'date',
	'email',
] as const;
export type ImportFieldType = (typeof IMPORT_FIELD_TYPES)[number];

/** How a row that already exists under the port's natural key is treated. */
export const IMPORT_MODES = [
	'create-only',
	'update-existing',
	'skip-existing',
] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

export interface ImportField {
	readonly id: string;
	readonly label: string;
	readonly required: boolean;
	readonly type: ImportFieldType;
}

/**
 * One CSV row after mapping. `row` is the 1-based data row number with the
 * header excluded, so it is the number the reader counts in their file, and
 * every verdict and outcome refers back to it. Values are the raw cell text
 * keyed by field id; a column the mapping did not name is absent rather than
 * empty, so a port can tell "not supplied" from "supplied blank".
 */
export interface ImportRow {
	readonly row: number;
	readonly values: Readonly<Record<string, string>>;
}

export interface ImportValidateInput {
	readonly tenantId: string;
	/**
	 * The principal that started the job, as it stood at that moment. A port
	 * checks its own record-level conditions against it; the declared
	 * `permission` is already checked by import.core before this call.
	 */
	readonly principal: AuthPrincipal;
	readonly rows: readonly ImportRow[];
}

/**
 * One verdict per row. A port may answer fewer entries than it was given; a row
 * it says nothing about is taken as valid, because a port reports what it
 * refuses rather than restating what it accepts.
 */
export interface ImportValidation {
	readonly row: number;
	readonly verdict: 'valid' | 'invalid';
	readonly field?: string;
	readonly reason?: string;
}

export interface ImportWriteInput {
	readonly tenantId: string;
	readonly principal: AuthPrincipal;
	readonly rows: readonly ImportRow[];
	readonly mode: ImportMode;
}

/**
 * One outcome per row. A row the port says nothing about is recorded as failed
 * with a stable reason rather than silently counted as written: a port that
 * drops a row has to be visible in the job.
 */
export interface ImportWriteOutcome {
	readonly row: number;
	readonly outcome: 'created' | 'updated' | 'skipped' | 'failed';
	readonly recordRef?: string;
	readonly reason?: string;
}

/**
 * One import target. The target id a job names is `<moduleId>.<key>`, for
 * example `users.core.members`.
 *
 * Guaranteed to the port: `validate` runs before any `write`; `write` is called
 * only for rows the port itself called valid; both are called with batches no
 * larger than the platform `batchSize` setting, in ascending row order, and
 * never concurrently for one job. Deliberately unspecified: how many batches a
 * job takes, whether two jobs of one workspace overlap, and how long the gap
 * between validate and write is, so a port must not carry state between calls.
 */
export interface ImportPort {
	readonly key: string;
	readonly label: string;
	/** The target module's own permission; import never widens what a member may write. */
	readonly permission: string;
	readonly fields: readonly ImportField[];
	/** The fields whose values make a repeat idempotent. */
	readonly naturalKey: readonly string[];
	/**
	 * The natural key of one row as this port compares two records of its own.
	 * import.core refuses a row repeating an earlier row's key across the whole
	 * file, and only the port knows what two values mean to it: an address it
	 * stores folded matches whatever case the file carries. Left out, the key
	 * fields are compared exactly, length prefixed so two fields cannot run into
	 * one another.
	 */
	naturalKeyOf?(values: ImportRow['values']): string;
	validate(input: ImportValidateInput): Promise<readonly ImportValidation[]>;
	write(input: ImportWriteInput): Promise<readonly ImportWriteOutcome[]>;
}

export interface ImportPorts {
	/**
	 * Registers a module's targets. Registration is open while the platform
	 * composes and sealed before the first request; a later call throws, so the
	 * set of targets a workspace can choose from never changes under it.
	 */
	register(moduleId: string, ports: readonly ImportPort[]): void;
}

/** Longest values a port declaration may carry; over any of them is refused. */
export const IMPORT_PORT_LIMITS = {
	moduleId: 64,
	key: 48,
	target: 96,
	label: 120,
	permission: 96,
	fieldId: 64,
	fieldLabel: 120,
	fields: 64,
	naturalKey: 8,
	portsPerModule: 32,
	reason: 200,
	recordRef: 200,
} as const;

export function importTargetId(moduleId: string, key: string): string {
	return `${moduleId}.${key}`;
}
