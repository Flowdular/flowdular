import { randomUUID } from 'node:crypto';
import type { AuthPrincipal } from '@flowdular/module-auth';
import { readCsv, CsvError, type CsvDocument } from '../domain/csv.ts';
import {
	IMPORT_MODES,
	type ImportField,
	type ImportFieldType,
	type ImportMode,
	type ImportRow,
	type ImportValidation,
	type ImportWriteOutcome,
} from '../domain/ports.ts';
import {
	IMPORT_CSV_CONTENT_TYPE,
	IMPORT_LIMITS,
	IMPORT_MAX_CSV_BYTES,
	IMPORT_UNEXPECTED_FAILURE,
	type ClaimedImportJob,
	type ImportJob,
	type ImportJobRow,
	type ImportJobStatus,
	type ImportMapping,
	type ImportRequester,
	type ImportRowOutcome,
} from '../domain/types.ts';
import { ImportSourceError, type ImportCsvSource } from './csv-source.ts';
import type {
	ImportPortRegistry,
	RegisteredImportPort,
} from './port-registry.ts';
import type {
	ImportJobPage,
	ImportJobQuery,
	ImportRepository,
	ImportRowPage,
} from './repository.ts';

export class ImportServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'ImportServiceError';
	}
}

/** One target as a screen sees it, with whether this reader may use it. */
export interface ImportTargetView {
	readonly target: string;
	readonly moduleId: string;
	readonly label: string;
	readonly permission: string;
	readonly permitted: boolean;
	readonly fields: readonly ImportField[];
	readonly naturalKey: readonly string[];
}

export interface StartImportInput {
	readonly target: string;
	readonly documentId: string;
	readonly documentRef: string;
	readonly mode: ImportMode;
	readonly dryRun: boolean;
	readonly columns: Readonly<Record<string, string>>;
}

export interface ImportServiceOptions {
	readonly repository: ImportRepository;
	readonly ports: ImportPortRegistry;
	readonly source: ImportCsvSource;
	readonly maxRows: () => number;
	readonly batchSize: () => number;
	readonly now?: () => number;
	readonly newId?: () => string;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@.]{1,63}(\.[^\s@.]{1,63})+$/;
const INTEGER = /^-?\d{1,15}$/;
const DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.+\-Z]{1,24})?$/;
const BOOLEAN = new Set(['true', 'false', 'yes', 'no', '1', '0']);

function shapeOf(value: string, type: ImportFieldType): boolean {
	switch (type) {
		case 'integer':
			return INTEGER.test(value) && Number.isSafeInteger(Number(value));
		case 'boolean':
			return BOOLEAN.has(value.toLowerCase());
		case 'date':
			return DATE.test(value) && Number.isFinite(Date.parse(value));
		case 'email':
			return value.length <= 254 && EMAIL.test(value);
		default:
			return true;
	}
}

function requesterOf(principal: AuthPrincipal): ImportRequester {
	const requester: ImportRequester = {
		accountId: principal.accountId,
		email: principal.email,
		displayName: principal.displayName,
		role: principal.role,
		scopes: [...principal.scopes],
	};
	/* The job row bounds the snapshot at 8 KB. A principal carrying more than
	   that is refused here with a code the screen can read, rather than by the
	   column check once the job is half written. */
	if (JSON.stringify(requester).length > IMPORT_LIMITS.json) {
		throw new ImportServiceError(
			'REQUESTER_TOO_LARGE',
			'Your account carries more grants than an import job can record.',
		);
	}
	return requester;
}

/**
 * The principal the port sees in a background stage. It carries the identity
 * and the grants the requester held when the job was started; the workspace is
 * the job's own, and other workspace memberships are never part of an import.
 */
function principalOf(job: ImportJob): AuthPrincipal {
	return {
		accountId: job.requester.accountId,
		tenantId: job.tenantId,
		email: job.requester.email,
		displayName: job.requester.displayName,
		role: job.requester.role,
		scopes: job.requester.scopes,
		tenants: [],
	};
}

/* The comparison a port that folds nothing gets: the key fields exactly as the
   file carries them, length prefixed so two fields cannot run into one another. */
function exactKey(key: readonly string[], values: ImportRow['values']): string {
	let composed = '';
	for (const field of key) {
		const value = values[field] ?? '';
		composed += `${value.length}:${value}`;
	}
	return composed;
}

function truncate(value: string | undefined, max: number): string | null {
	if (value === undefined) return null;
	const normalized = value.trim();
	if (normalized === '') return null;
	return normalized.length > max ? normalized.slice(0, max) : normalized;
}

export class ImportService {
	readonly #repository: ImportRepository;
	readonly #ports: ImportPortRegistry;
	readonly #source: ImportCsvSource;
	readonly #maxRows: () => number;
	readonly #batchSize: () => number;
	readonly #now: () => number;
	readonly #newId: () => string;

	constructor(options: ImportServiceOptions) {
		this.#repository = options.repository;
		this.#ports = options.ports;
		this.#source = options.source;
		this.#maxRows = options.maxRows;
		this.#batchSize = options.batchSize;
		this.#now = options.now ?? (() => Date.now());
		this.#newId = options.newId ?? (() => randomUUID());
	}

	targets(principal: AuthPrincipal): readonly ImportTargetView[] {
		return this.#ports.list().map((registered) => ({
			target: registered.target,
			moduleId: registered.moduleId,
			label: registered.port.label,
			permission: registered.port.permission,
			permitted: principal.scopes.includes(registered.port.permission),
			fields: registered.port.fields,
			naturalKey: registered.port.naturalKey,
		}));
	}

	async start(
		principal: AuthPrincipal,
		input: StartImportInput,
	): Promise<ImportJob> {
		const registered = this.#require(input.target);
		/* The target module's own permission, checked on the acting principal
		   before anything is recorded, so an import never widens what a member
		   may write. */
		if (!principal.scopes.includes(registered.port.permission)) {
			throw new ImportServiceError(
				'TARGET_FORBIDDEN',
				'You do not hold the permission this import target requires.',
				403,
			);
		}
		if (!(IMPORT_MODES as readonly string[]).includes(input.mode)) {
			throw new ImportServiceError(
				'MODE_UNKNOWN',
				'The import mode is unknown.',
			);
		}
		this.#assertMapping(registered, input.columns);
		const requester = requesterOf(principal);

		/* Every bound the metadata can answer is answered here, so an oversized or
		   non-CSV document never becomes a job at all. */
		const document = await this.#source.describe(
			principal.tenantId,
			input.documentRef,
			input.documentId,
		);
		if (!document || document.status === 'deleted') {
			throw new ImportServiceError(
				'SOURCE_NOT_FOUND',
				'The source document is not stored in this workspace.',
				404,
			);
		}
		if (document.scan === 'infected') {
			throw new ImportServiceError(
				'SOURCE_INFECTED',
				'The source document was refused by the malware scanner.',
			);
		}
		if (document.contentType !== IMPORT_CSV_CONTENT_TYPE) {
			throw new ImportServiceError(
				'SOURCE_NOT_CSV',
				'The source document is not a CSV file.',
			);
		}
		if (document.bytes > IMPORT_MAX_CSV_BYTES) {
			throw new ImportServiceError(
				'SOURCE_TOO_LARGE',
				`The source document is larger than ${IMPORT_MAX_CSV_BYTES} bytes.`,
			);
		}

		return this.#repository.createJob({
			id: this.#newId(),
			tenantId: principal.tenantId,
			target: registered.target,
			documentId: input.documentId,
			documentRef: input.documentRef,
			mode: input.mode,
			dryRun: input.dryRun,
			validOnly: false,
			status: 'parsing',
			totalRows: 0,
			validRows: 0,
			writtenRows: 0,
			failedRows: 0,
			requesterAccountId: principal.accountId,
			requester,
			columns: { ...input.columns },
			failureCode: null,
			claimedAt: null,
			startedAt: this.#now(),
			completedAt: null,
		});
	}

	async continue(
		principal: AuthPrincipal,
		id: string,
		validOnly: boolean,
	): Promise<ImportJob> {
		const job = await this.#requireJob(principal.tenantId, id);
		if (job.dryRun) {
			throw new ImportServiceError(
				'JOB_DRY_RUN',
				'A dry run writes nothing; start a new job to write these rows.',
				409,
			);
		}
		if (job.status !== 'validated') {
			throw new ImportServiceError(
				'JOB_NOT_VALIDATED',
				'Only a validated job can be continued.',
				409,
			);
		}
		/* The grant is re-checked on the live principal: a job validated before a
		   permission was revoked must not write afterwards. */
		const registered = this.#require(job.target);
		if (!principal.scopes.includes(registered.port.permission)) {
			throw new ImportServiceError(
				'TARGET_FORBIDDEN',
				'You do not hold the permission this import target requires.',
				403,
			);
		}
		if (!validOnly && job.validRows !== job.totalRows) {
			throw new ImportServiceError(
				'VALIDATION_FAILED',
				'This job has invalid rows; continue with the valid rows only.',
				409,
			);
		}
		const moved = await this.#repository.continueJob(
			principal.tenantId,
			id,
			validOnly,
		);
		if (!moved) {
			throw new ImportServiceError(
				'JOB_NOT_VALIDATED',
				'Only a validated job can be continued.',
				409,
			);
		}
		return moved;
	}

	async cancel(principal: AuthPrincipal, id: string): Promise<ImportJob> {
		const job = await this.#requireJob(principal.tenantId, id);
		const cancelled = await this.#repository.advanceJob(
			principal.tenantId,
			id,
			['validated'],
			{
				status: 'cancelled',
				totalRows: job.totalRows,
				validRows: job.validRows,
				writtenRows: job.writtenRows,
				failedRows: job.failedRows,
				failureCode: null,
				completedAt: this.#now(),
			},
		);
		if (!cancelled) {
			throw new ImportServiceError(
				'JOB_NOT_VALIDATED',
				'Only a validated job can be cancelled.',
				409,
			);
		}
		return cancelled;
	}

	async job(tenantId: string, id: string): Promise<ImportJob> {
		return this.#requireJob(tenantId, id);
	}

	async jobs(tenantId: string, query: ImportJobQuery): Promise<ImportJobPage> {
		return this.#repository.listJobs(tenantId, query);
	}

	async rows(
		tenantId: string,
		jobId: string,
		limit: number,
		after?: number,
	): Promise<ImportRowPage> {
		await this.#requireJob(tenantId, jobId);
		return this.#repository.listJobRows(tenantId, jobId, limit, after);
	}

	async mapping(
		tenantId: string,
		target: string,
	): Promise<ImportMapping | null> {
		this.#require(target);
		return this.#repository.findMapping(tenantId, target);
	}

	async saveMapping(
		principal: AuthPrincipal,
		target: string,
		columns: Readonly<Record<string, string>>,
	): Promise<ImportMapping> {
		const registered = this.#require(target);
		if (!principal.scopes.includes(registered.port.permission)) {
			throw new ImportServiceError(
				'TARGET_FORBIDDEN',
				'You do not hold the permission this import target requires.',
				403,
			);
		}
		this.#assertMapping(registered, columns);
		const existing = await this.#repository.findMapping(
			principal.tenantId,
			target,
		);
		return this.#repository.saveMapping({
			id: existing?.id ?? this.#newId(),
			tenantId: principal.tenantId,
			target,
			columns: { ...columns },
			updatedAt: this.#now(),
		});
	}

	/**
	 * One stage of one claimed job. It never throws: a failure is the job's
	 * recorded outcome, because the operator reads the job, not this process's
	 * log.
	 */
	async perform(job: ClaimedImportJob): Promise<ImportJob> {
		try {
			return job.status === 'parsing'
				? await this.#parseAndValidate(job)
				: await this.#write(job);
		} catch (error) {
			/* The lease lapsed and another loop reclaimed the job. It is that loop's
			   work now, so this stage records nothing at all: failing the job here
			   would settle work that is still running. */
			if (error instanceof ImportServiceError && error.code === 'CLAIM_LOST') {
				return (await this.#repository.findJob(job.tenantId, job.id)) ?? job;
			}
			const code =
				error instanceof CsvError || error instanceof ImportSourceError
					? error.code
					: error instanceof ImportServiceError
						? error.code
						: IMPORT_UNEXPECTED_FAILURE;
			return (
				(await this.#repository.advanceJob(job.tenantId, job.id, [job.status], {
					status: 'failed',
					totalRows: job.totalRows,
					validRows: job.validRows,
					writtenRows: job.writtenRows,
					failedRows: job.failedRows,
					failureCode: code.slice(0, IMPORT_LIMITS.failureCode),
					completedAt: this.#now(),
				})) ?? job
			);
		}
	}

	async #parseAndValidate(job: ClaimedImportJob): Promise<ImportJob> {
		const registered = this.#require(job.target);
		const document = await this.#read(job);
		const { rows, invalid } = this.#map(registered, job, document);

		const verdicts = new Map<number, ImportValidation>();
		for (const entry of invalid) verdicts.set(entry.row, entry);
		for (const entry of this.#duplicates(registered, rows)) {
			verdicts.set(entry.row, entry);
		}
		/* A row already refused is never offered to the port: the port answers
		   refusals for rows it was given, and a duplicate is refused here. */
		const pending = rows.filter((row) => !verdicts.has(row.row));

		const batch = this.#batchSize();
		const principal = principalOf(job);
		const renew = this.#renewal(job);
		for (let start = 0; start < pending.length; start += batch) {
			const slice = pending.slice(start, start + batch);
			for (const verdict of await this.#validate(registered, {
				tenantId: job.tenantId,
				principal,
				rows: slice,
			})) {
				if (verdict.verdict === 'invalid') verdicts.set(verdict.row, verdict);
			}
			await renew();
		}

		const outcomes: ImportJobRow[] = [];
		const total = document.rows.length;
		let validRows = 0;
		for (let row = 1; row <= total; row += 1) {
			const verdict = verdicts.get(row);
			if (!verdict) validRows += 1;
			outcomes.push(
				this.#outcomeRow(job, row, verdict ? 'invalid' : 'valid', {
					field: verdict?.field,
					reason: verdict?.reason,
				}),
			);
		}
		await this.#repository.replaceJobRows(job.tenantId, job.id, outcomes);

		const failed = total - validRows;
		const completed = job.dryRun;
		return (
			(await this.#repository.advanceJob(job.tenantId, job.id, ['parsing'], {
				status: completed ? 'completed' : 'validated',
				totalRows: total,
				validRows,
				writtenRows: 0,
				failedRows: failed,
				failureCode: null,
				completedAt: completed ? this.#now() : null,
			})) ?? job
		);
	}

	async #write(job: ClaimedImportJob): Promise<ImportJob> {
		const registered = this.#require(job.target);
		const document = await this.#read(job);
		const { rows } = this.#map(registered, job, document);
		const valid = new Set(
			await this.#repository.listValidRowNumbers(job.tenantId, job.id),
		);
		const writable = rows.filter((row) => valid.has(row.row));

		const batch = this.#batchSize();
		const principal = principalOf(job);
		const renew = this.#renewal(job);
		for (let start = 0; start < writable.length; start += batch) {
			const slice = writable.slice(start, start + batch);
			const outcomes = await this.#writeBatch(registered, {
				tenantId: job.tenantId,
				principal,
				rows: slice,
				mode: job.mode,
			});
			const byRow = new Map(outcomes.map((entry) => [entry.row, entry]));
			const recorded: ImportJobRow[] = [];
			for (const row of slice) {
				/* A row the port said nothing about is recorded as failed: a dropped
				   row has to be visible in the job rather than counted as written. */
				const outcome = byRow.get(row.row) ?? {
					row: row.row,
					outcome: 'failed' as const,
					reason: 'PORT_SILENT',
				};
				recorded.push(
					this.#outcomeRow(job, row.row, outcome.outcome, {
						reason: outcome.reason,
						recordRef: outcome.recordRef,
					}),
				);
			}
			await this.#repository.recordJobRows(job.tenantId, recorded);
			await renew();
		}

		/* The counts are read back from the outcomes rather than counted in this
		   pass: a job reclaimed after a crash writes only the rows the earlier
		   pass had not reached, and an in-memory counter would report those alone.
		   A skipped row is neither written nor failed: the natural key already
		   held it, so a skip-existing repeat reports zero written. */
		const counts = await this.#repository.countRowOutcomes(
			job.tenantId,
			job.id,
		);
		return (
			(await this.#repository.advanceJob(job.tenantId, job.id, ['writing'], {
				status: 'completed',
				totalRows: job.totalRows,
				validRows: job.validRows,
				writtenRows: counts.created + counts.updated,
				failedRows: counts.invalid + counts.failed,
				failureCode: null,
				completedAt: this.#now(),
			})) ?? job
		);
	}

	/**
	 * The renewal this stage calls once per batch, so a job longer than the
	 * runner's lease is not taken up a second time while it is still being
	 * written. Every renewal is fenced on the claim the stage holds: one that
	 * matches nothing means the lease lapsed and another loop reclaimed the job,
	 * and the stage stops there rather than writing on behalf of a claim it no
	 * longer has. A renewal the database could not answer at all is not the job's
	 * failure: the claim is unchanged, so the next batch renews against it again.
	 */
	#renewal(job: ClaimedImportJob): () => Promise<void> {
		let held = job.claimedAt;
		return async () => {
			const at = this.#now();
			let renewed: boolean;
			try {
				renewed = await this.#repository.heartbeatJob(
					job.tenantId,
					job.id,
					at,
					held,
				);
			} catch {
				return;
			}
			if (!renewed) {
				throw new ImportServiceError(
					'CLAIM_LOST',
					'Another process took this import job over while it was running.',
					409,
				);
			}
			held = at;
		};
	}

	/**
	 * Rows repeating an earlier row's natural key, refused before batching. A
	 * port carries no state between calls, so a repeat in a later batch would
	 * otherwise meet its own earlier row as an existing record and be written
	 * twice or refused as somebody else's. Which two values are one key is the
	 * port's own decision: it folds them in `naturalKeyOf`, and without one they
	 * are compared exactly.
	 */
	#duplicates(
		registered: RegisteredImportPort,
		rows: readonly ImportRow[],
	): readonly ImportValidation[] {
		const port = registered.port;
		const key = port.naturalKey;
		const first = key[0];
		if (first === undefined) return [];
		const seen = new Set<string>();
		const duplicates: ImportValidation[] = [];
		for (const row of rows) {
			let composed: string;
			try {
				composed = port.naturalKeyOf?.(row.values) ?? exactKey(key, row.values);
			} catch {
				/* The fold is another module's code: a throwing one costs this file
				   the port's own comparison, never the duplicate check itself. */
				composed = exactKey(key, row.values);
			}
			if (seen.has(composed)) {
				duplicates.push({
					row: row.row,
					verdict: 'invalid',
					field: first,
					reason: 'NATURAL_KEY_DUPLICATE',
				});
				continue;
			}
			seen.add(composed);
		}
		return duplicates;
	}

	/* A port is another module's code. It is isolated so a throwing port fails
	   its own batch's rows and never the platform's loop; the rows it was given
	   are recorded as failed with a stable reason. */
	async #validate(
		registered: RegisteredImportPort,
		input: Parameters<RegisteredImportPort['port']['validate']>[0],
	): Promise<readonly ImportValidation[]> {
		try {
			return await registered.port.validate(input);
		} catch {
			return input.rows.map((row) => ({
				row: row.row,
				verdict: 'invalid' as const,
				reason: 'PORT_FAILED',
			}));
		}
	}

	async #writeBatch(
		registered: RegisteredImportPort,
		input: Parameters<RegisteredImportPort['port']['write']>[0],
	): Promise<readonly ImportWriteOutcome[]> {
		try {
			return await registered.port.write(input);
		} catch {
			return input.rows.map((row) => ({
				row: row.row,
				outcome: 'failed' as const,
				reason: 'PORT_FAILED',
			}));
		}
	}

	async #read(job: ImportJob): Promise<CsvDocument> {
		const body = await this.#source.open(
			job.tenantId,
			job.documentRef,
			job.documentId,
		);
		return readCsv(body, {
			maxBytes: IMPORT_MAX_CSV_BYTES,
			maxRows: this.#maxRows(),
		});
	}

	/**
	 * Maps CSV cells onto port fields. Header positions are resolved once, so
	 * mapping is O(rows x fields) and never searches the header per cell.
	 */
	#map(
		registered: RegisteredImportPort,
		job: ImportJob,
		document: CsvDocument,
	): { rows: readonly ImportRow[]; invalid: readonly ImportValidation[] } {
		const position = new Map(
			document.header.map((name, index) => [name, index]),
		);
		const columns: { field: ImportField; index: number }[] = [];
		for (const field of registered.port.fields) {
			const header = job.columns[field.id];
			if (header === undefined) {
				if (field.required) {
					throw new ImportServiceError(
						'MAPPING_COLUMN_MISSING',
						`The file has no column for ${field.id}.`,
					);
				}
				continue;
			}
			/* A mapped column the file does not carry fails the job whether the
			   field is required or not: skipping it would import the file the
			   requester mapped as if that column had been left out on purpose. */
			const index = position.get(header);
			if (index === undefined) {
				throw new ImportServiceError(
					'MAPPING_COLUMN_MISSING',
					`The file has no column ${header} for ${field.id}.`,
				);
			}
			columns.push({ field, index });
		}

		const rows: ImportRow[] = [];
		const invalid: ImportValidation[] = [];
		for (const record of document.rows) {
			/* A row whose cell count differs from the header is reported rather
			   than padded or truncated: silently dropping a trailing cell writes a
			   record the file did not describe. */
			if (record.cells.length !== document.header.length) {
				invalid.push({
					row: record.row,
					verdict: 'invalid',
					reason: 'ROW_RAGGED',
				});
				continue;
			}
			const values: Record<string, string> = {};
			let refusal: ImportValidation | null = null;
			for (const { field, index } of columns) {
				const cell = record.cells[index] ?? '';
				if (cell === '') {
					if (field.required) {
						refusal = {
							row: record.row,
							verdict: 'invalid',
							field: field.id,
							reason: 'FIELD_REQUIRED',
						};
						break;
					}
					continue;
				}
				if (!shapeOf(cell, field.type)) {
					refusal = {
						row: record.row,
						verdict: 'invalid',
						field: field.id,
						reason: 'FIELD_TYPE',
					};
					break;
				}
				values[field.id] = cell;
			}
			if (refusal) invalid.push(refusal);
			else rows.push({ row: record.row, values });
		}
		return { rows, invalid };
	}

	#outcomeRow(
		job: ImportJob,
		rowNumber: number,
		outcome: ImportRowOutcome,
		detail: {
			readonly field?: string | undefined;
			readonly reason?: string | undefined;
			readonly recordRef?: string | undefined;
		},
	): ImportJobRow {
		return {
			id: this.#newId(),
			tenantId: job.tenantId,
			jobId: job.id,
			rowNumber,
			outcome,
			field: truncate(detail.field, IMPORT_LIMITS.field),
			reason: truncate(detail.reason, IMPORT_LIMITS.reason),
			recordRef: truncate(detail.recordRef, IMPORT_LIMITS.recordRef),
		};
	}

	#assertMapping(
		registered: RegisteredImportPort,
		columns: Readonly<Record<string, string>>,
	): void {
		/* The job row and the saved mapping each bound the serialized object at
		   8 KB, and the endpoint's per-entry bounds still allow a mapping past it.
		   It is refused here with a code the screen can read, rather than by the
		   column check once the job is half written. */
		if (JSON.stringify(columns).length > IMPORT_LIMITS.json) {
			throw new ImportServiceError(
				'MAPPING_TOO_LARGE',
				'The column mapping is larger than an import job can record.',
			);
		}
		const fields = new Map(
			registered.port.fields.map((field) => [field.id, field]),
		);
		/* One header feeds one field. Two fields reading one column would write
		   the same cell under two meanings, which is a mapping mistake rather
		   than a choice the file can answer. */
		const headers = new Map<string, string>();
		for (const [id, header] of Object.entries(columns)) {
			if (!fields.has(id)) {
				throw new ImportServiceError(
					'MAPPING_UNKNOWN_FIELD',
					`The target has no field ${id}.`,
				);
			}
			const taken = headers.get(header);
			if (taken !== undefined) {
				throw new ImportServiceError(
					'MAPPING_COLUMN_REUSED',
					`The column ${header} is mapped to ${taken} and ${id}.`,
				);
			}
			headers.set(header, id);
		}
		for (const field of registered.port.fields) {
			if (field.required && !columns[field.id]) {
				throw new ImportServiceError(
					'MAPPING_INCOMPLETE',
					`The required field ${field.id} has no column.`,
				);
			}
		}
	}

	#require(target: string): RegisteredImportPort {
		const registered = this.#ports.find(target);
		if (!registered) {
			throw new ImportServiceError(
				'TARGET_UNKNOWN',
				'No module offers that import target.',
				404,
			);
		}
		return registered;
	}

	async #requireJob(tenantId: string, id: string): Promise<ImportJob> {
		const job = await this.#repository.findJob(tenantId, id);
		if (!job) {
			throw new ImportServiceError('JOB_NOT_FOUND', 'No such import job.', 404);
		}
		return job;
	}
}

export type { ImportJobStatus };
