import { randomUUID } from 'node:crypto';
import type { Actor, ActorKind } from './actor.ts';
import type { MigrationDatabase } from './migrations.ts';

export type HistoryValue = string | number | boolean | null;

export interface FieldChange {
	readonly from: HistoryValue;
	readonly to: HistoryValue;
}

export type RecordChanges = Readonly<Record<string, FieldChange>>;

export type TrackedFields = Readonly<Record<string, HistoryValue>>;

export interface HistoryEntry {
	readonly id: string;
	readonly recordId: string;
	readonly version: number;
	readonly action: string;
	readonly actor: Actor;
	readonly changes: RecordChanges;
	readonly occurredAt: number;
}

export interface HistoryWrite {
	readonly tenantId: string;
	readonly recordId: string;
	readonly action: string;
	readonly actor: Actor;
	readonly changes: RecordChanges;
	readonly occurredAt: number;
}

export interface HistoryQuery {
	readonly tenantId: string;
	readonly recordId: string;
	readonly limit: number;
	/** The `version` of the last entry of the previous page. */
	readonly cursor?: string | null;
}

export interface HistoryPage {
	readonly entries: readonly HistoryEntry[];
	readonly nextCursor: string | null;
}

/* What a history endpoint reads off the query string. Every module parses the
   same contract so one client can page all of them. */
export interface HistoryRequest {
	readonly recordId: string;
	readonly limit: number;
	readonly cursor: string | null;
}

export const MAX_HISTORY_PAGE = 100;
export const DEFAULT_HISTORY_PAGE = 50;
const MAX_RECORD_ID_LENGTH = 128;
const MAX_CURSOR_LENGTH = 32;

/* Null when no record was named; the caller answers with its own refusal. */
export function parseHistoryRequest(
	search: URLSearchParams,
): HistoryRequest | null {
	const recordId = (search.get('recordId') ?? '').trim();
	if (recordId.length === 0 || recordId.length > MAX_RECORD_ID_LENGTH) {
		return null;
	}
	const limit = Number(search.get('limit') ?? DEFAULT_HISTORY_PAGE);
	const cursor = (search.get('cursor') ?? '').trim();
	return {
		recordId,
		limit: Number.isSafeInteger(limit) ? limit : DEFAULT_HISTORY_PAGE,
		cursor:
			cursor.length > 0 && cursor.length <= MAX_CURSOR_LENGTH ? cursor : null,
	};
}

const TABLE_NAME = /^[a-z][a-z0-9_]*$/;

interface HistoryRow {
	id: string;
	record_id: string;
	version: number;
	action: string;
	actor_kind: ActorKind;
	actor_id: string;
	actor_label: string;
	run_id: string | null;
	configured_by_json: string | null;
	changes_json: string;
	occurred_at: number;
}

function actorFromRow(row: HistoryRow): Actor {
	if (row.actor_kind === 'user') {
		return { kind: 'user', id: row.actor_id, label: row.actor_label };
	}
	if (row.actor_kind === 'service') {
		if (row.configured_by_json === null) {
			throw new Error(
				`Service history entry "${row.id}" has no configuring user.`,
			);
		}
		const configuredBy = JSON.parse(row.configured_by_json) as Actor;
		if (configuredBy.kind !== 'user') {
			throw new Error(
				`Service history entry "${row.id}" has an invalid configuring user.`,
			);
		}
		return {
			kind: 'service',
			id: row.actor_id,
			label: row.actor_label,
			configuredBy,
		};
	}
	if (row.run_id === null) {
		throw new Error(
			`Agent history entry "${row.id}" has no traceable run identifier.`,
		);
	}
	return {
		kind: 'agent',
		id: row.actor_id,
		label: row.actor_label,
		runId: row.run_id,
	};
}

function hasConfiguredByColumn(
	database: MigrationDatabase,
	table: string,
): boolean {
	return database
		.prepare(`PRAGMA table_info(${tableOf(table)})`)
		.all()
		.some(
			(row) =>
				typeof row === 'object' &&
				row !== null &&
				'name' in row &&
				row.name === 'configured_by_json',
		);
}

/* SQLite cannot parameterize a table name, so every caller passes a constant
   from its own module and it is checked before it reaches a statement. */
function tableOf(table: string): string {
	if (!TABLE_NAME.test(table)) {
		throw new Error(`"${table}" is not a history table name.`);
	}
	return table;
}

/* Only what changed: a field whose value is untouched is never stored, and a
   creation records the fields that were actually set. */
export function diffFields(
	before: TrackedFields | null,
	after: TrackedFields,
): RecordChanges {
	const changes: Record<string, FieldChange> = {};
	for (const [field, value] of Object.entries(after)) {
		if (before === null) {
			if (value !== null) changes[field] = { from: null, to: value };
			continue;
		}
		const previous = before[field] ?? null;
		if (previous !== value) changes[field] = { from: previous, to: value };
	}
	return changes;
}

/* The record change and its history row must reach the database together, or
   the trail could disagree with the record it describes. */
export function inTransaction<T>(database: MigrationDatabase, run: () => T): T {
	database.exec('BEGIN IMMEDIATE');
	try {
		const result = run();
		database.exec('COMMIT');
		return result;
	} catch (error) {
		try {
			database.exec('ROLLBACK');
		} catch {
			/* The failure already aborted the transaction; keep the real cause. */
		}
		throw error;
	}
}

/* Call inside inTransaction, next to the record write. The version is read
   under the same write lock and the unique index is the backstop. */
export function appendHistory(
	database: MigrationDatabase,
	table: string,
	write: HistoryWrite,
): number {
	const name = tableOf(table);
	const supportsService = hasConfiguredByColumn(database, name);
	if (write.actor.kind === 'service' && !supportsService) {
		throw new Error(
			`History table "${name}" must add configured_by_json before it can store service actors.`,
		);
	}
	const previous = database
		.prepare(
			`SELECT max(version) AS version FROM ${name}
			 WHERE tenant_id = ? AND record_id = ?`,
		)
		.get(write.tenantId, write.recordId) as { version: number | null };
	const version = (previous.version ?? 0) + 1;
	const columns = supportsService ? ', configured_by_json' : '';
	const placeholder = supportsService ? ', ?' : '';
	database
		.prepare(
			`INSERT INTO ${name}
			 (id, tenant_id, record_id, version, action, actor_kind, actor_id,
			  actor_label, run_id, changes_json, occurred_at${columns})
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${placeholder})`,
		)
		.run(
			randomUUID(),
			write.tenantId,
			write.recordId,
			version,
			write.action,
			write.actor.kind,
			write.actor.id,
			write.actor.label,
			write.actor.kind === 'agent' ? write.actor.runId : null,
			JSON.stringify(write.changes),
			write.occurredAt,
			...(supportsService
				? [
						write.actor.kind === 'service'
							? JSON.stringify(write.actor.configuredBy)
							: null,
					]
				: []),
		);
	return version;
}

export function queryHistory(
	database: MigrationDatabase,
	table: string,
	query: HistoryQuery,
): HistoryPage {
	const name = tableOf(table);
	const configuredBy = hasConfiguredByColumn(database, name)
		? 'configured_by_json'
		: 'NULL AS configured_by_json';
	const limit = Math.min(
		Math.max(1, Math.trunc(query.limit)),
		MAX_HISTORY_PAGE,
	);
	const cursor = Number(query.cursor ?? Number.NaN);
	const bounded = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : null;
	const rows = database
		.prepare(
			`SELECT id, record_id, version, action, actor_kind, actor_id, actor_label,
			 run_id, ${configuredBy}, changes_json, occurred_at FROM ${name}
			 WHERE tenant_id = ? AND record_id = ?${bounded === null ? '' : ' AND version < ?'}
			 ORDER BY version DESC LIMIT ?`,
		)
		.all(
			...(bounded === null
				? [query.tenantId, query.recordId, limit + 1]
				: [query.tenantId, query.recordId, bounded, limit + 1]),
		) as readonly HistoryRow[];
	const page = rows.slice(0, limit).map(
		(row): HistoryEntry => ({
			id: row.id,
			recordId: row.record_id,
			version: row.version,
			action: row.action,
			actor: actorFromRow(row),
			changes: JSON.parse(row.changes_json) as RecordChanges,
			occurredAt: row.occurred_at,
		}),
	);
	const last = page[page.length - 1];
	return {
		entries: page,
		nextCursor: rows.length > limit && last ? String(last.version) : null,
	};
}
