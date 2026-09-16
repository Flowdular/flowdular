import type { AuthPrincipal } from '@flowdular/module-auth';
import type { ImportField, ImportMode, ImportRow } from './ports.ts';

/**
 * The programmatic write another module resolves to hand rows it already
 * holds to an import port, without a CSV and without a job:
 * `context.capabilities.get<ImportWrite>(IMPORT_WRITE_CAPABILITY)`.
 *
 * import.core applies the same contract its CSV jobs apply: the port's
 * permission on the principal, the declared field shapes, a natural key that
 * appears once per call, the port's own `validate` before its `write`, and a
 * port failure isolated to the batch it was given. The port writes inside its
 * own tenant transaction; the caller keeps any record of the outcomes.
 */
export const IMPORT_WRITE_CAPABILITY = 'import.write.v1';

/** A port as a caller sees it before writing through it. */
export interface ImportWriteTarget {
	readonly target: string;
	readonly moduleId: string;
	readonly key: string;
	readonly label: string;
	readonly permission: string;
	readonly fields: readonly ImportField[];
	readonly naturalKey: readonly string[];
	/** Rows one `validate` or `write` call may carry. */
	readonly batchSize: number;
}

export interface ImportWriteRowsInput {
	readonly tenantId: string;
	/** The live principal the rows are written for; its workspace must be `tenantId`. */
	readonly principal: AuthPrincipal;
	readonly moduleId: string;
	readonly portKey: string;
	/** Row numbers are the caller's own, positive and unique within the call. */
	readonly rows: readonly ImportRow[];
}

export interface ImportWriteRequest extends ImportWriteRowsInput {
	readonly mode: ImportMode;
	/** The caller's reference for this write, such as a run id, carried on the trace. */
	readonly sourceRef: string;
}

export interface ImportWriteVerdict {
	readonly row: number;
	readonly verdict: 'valid' | 'invalid';
	readonly field?: string;
	readonly reason?: string;
}

/** One per row, in the order the rows were given. */
export interface ImportWriteResult {
	readonly row: number;
	readonly outcome: 'created' | 'updated' | 'skipped' | 'invalid' | 'failed';
	readonly field?: string;
	readonly reason?: string;
	readonly recordRef?: string;
}

export interface ImportWrite {
	/** Null when no module registered that port. */
	describe(moduleId: string, portKey: string): ImportWriteTarget | null;
	/** Checks the rows as `write` would and writes nothing. */
	validate(input: ImportWriteRowsInput): Promise<readonly ImportWriteVerdict[]>;
	write(input: ImportWriteRequest): Promise<readonly ImportWriteResult[]>;
}
