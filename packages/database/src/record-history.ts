import { randomUUID } from 'node:crypto';
import {
	MAX_HISTORY_PAGE,
	type Actor,
	type ActorKind,
	type HistoryEntry,
	type HistoryPage,
	type HistoryQuery,
	type HistoryWrite,
	type RecordChanges,
} from '@flowdular/kernel';
import {
	assertSchemaName,
	type DatabaseParameter,
	type DatabaseSession,
} from './contracts.ts';
import { integer } from './decoders.ts';

interface HistoryRow {
	readonly id: string;
	readonly record_id: string;
	readonly version: number | bigint | string;
	readonly action: string;
	readonly actor_kind: ActorKind;
	readonly actor_id: string;
	readonly actor_label: string;
	readonly run_id: string | null;
	readonly configured_by_json: string | null;
	readonly changes_json: string;
	readonly occurred_at: number | bigint | string;
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

function placeholders(
	database: DatabaseSession,
	count: number,
	from = 1,
): string {
	return Array.from({ length: count }, (_value, index) =>
		database.capabilities.sql.placeholder(from + index),
	).join(', ');
}

/**
 * Appends one history version. Call it inside the same transaction as the
 * record write, or the trail can disagree with the record it describes. The
 * version is read under that transaction and the unique index is the backstop.
 */
export async function appendRecordHistory(
	database: DatabaseSession,
	table: string,
	write: HistoryWrite,
): Promise<number> {
	assertSchemaName(table);
	const supportsService = await database.schema.hasColumn(
		table,
		'configured_by_json',
	);
	if (write.actor.kind === 'service' && !supportsService) {
		throw new Error(
			`History table "${table}" must add configured_by_json before it can store service actors.`,
		);
	}
	const previous = await database.query<{
		version: number | bigint | string | null;
	}>({
		text: `SELECT max(version) AS version FROM ${table}
		       WHERE tenant_id = ${database.capabilities.sql.placeholder(1)}
		         AND record_id = ${database.capabilities.sql.placeholder(2)}`,
		parameters: [write.tenantId, write.recordId],
	});
	const current = previous.rows[0]?.version ?? null;
	const version =
		(current === null ? 0 : integer(current, 'version', { min: 0 })) + 1;
	const values: DatabaseParameter[] = [
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
	];
	if (supportsService) {
		values.push(
			write.actor.kind === 'service'
				? JSON.stringify(write.actor.configuredBy)
				: null,
		);
	}
	const columns = supportsService ? ', configured_by_json' : '';
	await database.execute({
		text: `INSERT INTO ${table}
		       (id, tenant_id, record_id, version, action, actor_kind, actor_id,
		        actor_label, run_id, changes_json, occurred_at${columns})
		       VALUES (${placeholders(database, values.length)})`,
		parameters: values,
	});
	return version;
}

/** One keyset page of a record's trail, newest version first. */
export async function queryRecordHistory(
	database: DatabaseSession,
	table: string,
	query: HistoryQuery,
): Promise<HistoryPage> {
	assertSchemaName(table);
	const configuredBy = (await database.schema.hasColumn(
		table,
		'configured_by_json',
	))
		? 'configured_by_json'
		: 'NULL AS configured_by_json';
	const limit = Math.min(
		Math.max(1, Math.trunc(query.limit)),
		MAX_HISTORY_PAGE,
	);
	const cursor = Number(query.cursor ?? Number.NaN);
	const bounded = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : null;
	const parameters: DatabaseParameter[] =
		bounded === null
			? [query.tenantId, query.recordId, limit + 1]
			: [query.tenantId, query.recordId, bounded, limit + 1];
	const marker = (position: number) =>
		database.capabilities.sql.placeholder(position);
	const versionFilter = bounded === null ? '' : ` AND version < ${marker(3)}`;
	const result = await database.query<HistoryRow>({
		text: `SELECT id, record_id, version, action, actor_kind, actor_id,
		              actor_label, run_id, ${configuredBy}, changes_json, occurred_at
		       FROM ${table}
		       WHERE tenant_id = ${marker(1)} AND record_id = ${marker(2)}${versionFilter}
		       ORDER BY version DESC LIMIT ${marker(parameters.length)}`,
		parameters,
	});
	const page = result.rows.slice(0, limit).map(
		(row): HistoryEntry => ({
			id: row.id,
			recordId: row.record_id,
			version: integer(row.version, 'version', { min: 0 }),
			action: row.action,
			actor: actorFromRow(row),
			changes: JSON.parse(row.changes_json) as RecordChanges,
			occurredAt: integer(row.occurred_at, 'timestamp', { min: 0 }),
		}),
	);
	const last = page[page.length - 1];
	return {
		entries: page,
		nextCursor:
			result.rows.length > limit && last ? String(last.version) : null,
	};
}
