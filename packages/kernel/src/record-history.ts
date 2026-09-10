import { randomUUID } from 'node:crypto';
import type { Actor, ActorKind } from './actor.ts';

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
