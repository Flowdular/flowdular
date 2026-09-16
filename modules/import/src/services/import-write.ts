import { serverTracer, type Tracer } from '@flowdular/server';
import {
	IMPORT_MODES,
	importTargetId,
	type ImportRow,
	type ImportValidation,
	type ImportWriteOutcome,
} from '../domain/ports.ts';
import { IMPORT_LIMITS } from '../domain/types.ts';
import type {
	ImportWrite,
	ImportWriteResult,
	ImportWriteRowsInput,
	ImportWriteTarget,
	ImportWriteVerdict,
} from '../domain/write.ts';
import { exactKey, ImportServiceError, shapeOf } from './import-service.ts';
import type {
	ImportPortRegistry,
	RegisteredImportPort,
} from './port-registry.ts';

export interface ImportWriteOptions {
	readonly ports: ImportPortRegistry;
	readonly batchSize: () => number;
	/** Defaults to the process tracer, which is the one `context.tracer` carries. */
	readonly tracer?: Tracer;
}

const IMPORT_WRITE_SPAN = 'import.core write';

function bounded(text: string | undefined, max: number): string | undefined {
	if (text === undefined) return undefined;
	const trimmed = text.trim();
	if (trimmed === '') return undefined;
	return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function verdictOf(
	row: number,
	field: string | undefined,
	reason: string,
): ImportValidation {
	return {
		row,
		verdict: 'invalid',
		...(field === undefined ? {} : { field }),
		reason,
	};
}

/**
 * The rows a call hands over, checked before any port code runs: the
 * principal's workspace and grant, the batch bound, the row numbers, and then
 * per row the declared field shapes and a natural key repeated within the
 * call. What survives is offered to the port's own `validate`.
 */
async function screen(
	registered: RegisteredImportPort,
	input: ImportWriteRowsInput,
	batchSize: number,
): Promise<{
	readonly refused: Map<number, ImportValidation>;
	readonly pending: readonly ImportRow[];
}> {
	if (input.principal.tenantId !== input.tenantId) {
		throw new ImportServiceError(
			'PRINCIPAL_TENANT_MISMATCH',
			'The principal does not belong to the workspace being written.',
			403,
		);
	}
	if (!input.principal.scopes.includes(registered.port.permission)) {
		throw new ImportServiceError(
			'TARGET_FORBIDDEN',
			'You do not hold the permission this import target requires.',
			403,
		);
	}
	if (!Array.isArray(input.rows) || input.rows.length > batchSize) {
		throw new ImportServiceError(
			'BATCH_TOO_LARGE',
			`One call carries at most ${batchSize} rows.`,
		);
	}
	const numbers = new Set<number>();
	for (const entry of input.rows) {
		if (
			!Number.isSafeInteger(entry?.row) ||
			entry.row < 1 ||
			numbers.has(entry.row) ||
			typeof entry.values !== 'object' ||
			entry.values === null
		) {
			throw new ImportServiceError(
				'ROWS_INVALID',
				'Every row needs a unique positive row number and an object of values.',
			);
		}
		numbers.add(entry.row);
	}

	const port = registered.port;
	const fields = new Map(port.fields.map((field) => [field.id, field]));
	const refused = new Map<number, ImportValidation>();
	const shaped: ImportRow[] = [];
	for (const entry of input.rows) {
		let refusal: ImportValidation | null = null;
		const values: Record<string, string> = {};
		for (const [id, value] of Object.entries(entry.values)) {
			if (!fields.has(id)) {
				refusal = verdictOf(entry.row, id, 'FIELD_UNKNOWN');
				break;
			}
			if (typeof value !== 'string') {
				refusal = verdictOf(entry.row, id, 'FIELD_TYPE');
				break;
			}
			if (value !== '') values[id] = value;
		}
		if (!refusal) {
			for (const field of port.fields) {
				const value = values[field.id];
				if (value === undefined) {
					if (field.required) {
						refusal = verdictOf(entry.row, field.id, 'FIELD_REQUIRED');
						break;
					}
					continue;
				}
				if (!shapeOf(value, field.type)) {
					refusal = verdictOf(entry.row, field.id, 'FIELD_TYPE');
					break;
				}
			}
		}
		if (refusal) refused.set(entry.row, refusal);
		else shaped.push({ row: entry.row, values });
	}

	const seen = new Set<string>();
	const pending: ImportRow[] = [];
	for (const row of shaped) {
		let key: string;
		try {
			key =
				port.naturalKeyOf?.(row.values) ??
				exactKey(port.naturalKey, row.values);
		} catch {
			key = exactKey(port.naturalKey, row.values);
		}
		if (seen.has(key)) {
			refused.set(
				row.row,
				verdictOf(row.row, port.naturalKey[0], 'NATURAL_KEY_DUPLICATE'),
			);
			continue;
		}
		seen.add(key);
		pending.push(row);
	}

	if (pending.length > 0) {
		let verdicts: readonly ImportValidation[];
		try {
			verdicts = await port.validate({
				tenantId: input.tenantId,
				principal: input.principal,
				rows: pending,
			});
		} catch {
			verdicts = pending.map((row) =>
				verdictOf(row.row, undefined, 'PORT_FAILED'),
			);
		}
		const offered = new Set(pending.map((row) => row.row));
		for (const verdict of verdicts) {
			if (verdict.verdict === 'invalid' && offered.has(verdict.row)) {
				refused.set(verdict.row, verdict);
			}
		}
	}
	return {
		refused,
		pending: pending.filter((row) => !refused.has(row.row)),
	};
}

function invalid(verdict: ImportValidation): ImportWriteResult {
	const field = bounded(verdict.field, IMPORT_LIMITS.field);
	const reason = bounded(verdict.reason, IMPORT_LIMITS.reason);
	return {
		row: verdict.row,
		outcome: 'invalid',
		...(field === undefined ? {} : { field }),
		...(reason === undefined ? {} : { reason }),
	};
}

/**
 * `import.write.v1` over the ports this module registered. It keeps no state
 * and opens no database: a port is another module's code writing its own
 * records, and the outcomes belong to the caller.
 */
export function createImportWrite(options: ImportWriteOptions): ImportWrite {
	const tracer = options.tracer ?? serverTracer();

	const resolve = (moduleId: string, portKey: string): RegisteredImportPort => {
		const registered =
			typeof moduleId === 'string' && typeof portKey === 'string'
				? options.ports.find(importTargetId(moduleId, portKey))
				: null;
		if (!registered || registered.moduleId !== moduleId) {
			throw new ImportServiceError(
				'TARGET_UNKNOWN',
				'No module offers that import target.',
				404,
			);
		}
		return registered;
	};

	return {
		describe(moduleId, portKey): ImportWriteTarget | null {
			const registered = options.ports.find(importTargetId(moduleId, portKey));
			if (!registered || registered.moduleId !== moduleId) return null;
			return {
				target: registered.target,
				moduleId: registered.moduleId,
				key: registered.port.key,
				label: registered.port.label,
				permission: registered.port.permission,
				fields: registered.port.fields,
				naturalKey: registered.port.naturalKey,
				batchSize: options.batchSize(),
			};
		},

		async validate(input): Promise<readonly ImportWriteVerdict[]> {
			const registered = resolve(input.moduleId, input.portKey);
			const { refused } = await screen(registered, input, options.batchSize());
			return input.rows.map((entry) => {
				const verdict = refused.get(entry.row);
				if (!verdict) return { row: entry.row, verdict: 'valid' as const };
				const { outcome: _outcome, ...detail } = invalid(verdict);
				return { ...detail, verdict: 'invalid' as const };
			});
		},

		async write(input): Promise<readonly ImportWriteResult[]> {
			const registered = resolve(input.moduleId, input.portKey);
			if (!(IMPORT_MODES as readonly string[]).includes(input.mode)) {
				throw new ImportServiceError(
					'MODE_UNKNOWN',
					'The import mode is unknown.',
				);
			}
			if (
				typeof input.sourceRef !== 'string' ||
				input.sourceRef.length === 0 ||
				input.sourceRef.length > IMPORT_LIMITS.recordRef
			) {
				throw new ImportServiceError(
					'SOURCE_REF_INVALID',
					`The source reference must be 1 to ${IMPORT_LIMITS.recordRef} characters.`,
				);
			}
			const span = tracer.startSpan(IMPORT_WRITE_SPAN, {
				attributes: {
					'flowdular.import.target': registered.target,
					'flowdular.import.rows': input.rows.length,
					'flowdular.import.source_ref': input.sourceRef,
				},
			});
			try {
				const { refused, pending } = await screen(
					registered,
					input,
					options.batchSize(),
				);
				let written: readonly ImportWriteOutcome[] = [];
				if (pending.length > 0) {
					try {
						written = await registered.port.write({
							tenantId: input.tenantId,
							principal: input.principal,
							rows: pending,
							mode: input.mode,
						});
					} catch {
						written = pending.map((row) => ({
							row: row.row,
							outcome: 'failed' as const,
							reason: 'PORT_FAILED',
						}));
					}
				}
				const offered = new Set(pending.map((row) => row.row));
				const byRow = new Map<number, ImportWriteOutcome>();
				for (const outcome of written) {
					if (offered.has(outcome.row)) byRow.set(outcome.row, outcome);
				}
				const results = input.rows.map((entry): ImportWriteResult => {
					const verdict = refused.get(entry.row);
					if (verdict) return invalid(verdict);
					/* A row the port said nothing about is failed, never counted as
					   written, as the CSV job path records it. */
					const outcome = byRow.get(entry.row) ?? {
						row: entry.row,
						outcome: 'failed' as const,
						reason: 'PORT_SILENT',
					};
					const reason = bounded(outcome.reason, IMPORT_LIMITS.reason);
					const recordRef = bounded(outcome.recordRef, IMPORT_LIMITS.recordRef);
					return {
						row: entry.row,
						outcome: outcome.outcome,
						...(reason === undefined ? {} : { reason }),
						...(recordRef === undefined ? {} : { recordRef }),
					};
				});
				span.end('ok');
				return results;
			} catch (error) {
				span.end(
					'error',
					error instanceof ImportServiceError
						? error.code
						: 'IMPORT_WRITE_FAILED',
				);
				throw error;
			}
		},
	};
}
