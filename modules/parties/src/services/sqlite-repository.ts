import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
	appendHistory,
	diffFields,
	inTransaction,
	queryHistory,
	runModuleMigrations,
	type Actor,
	type HistoryPage,
	type HistoryQuery,
	type TrackedFields,
} from '@coreloom/kernel';
import type { Party, UpdatePartyInput } from '../domain/types.ts';
import { migrations } from './migration.ts';
import type { PartyRepository } from './repository.ts';
import {
	canonicalDigest,
	TargetIdempotencyCorruptionError,
	TargetIdempotencyConflictError,
	type TargetIdempotencyEntry,
	type TargetIdempotencyRequest,
} from './target-idempotency.ts';

const HISTORY_TABLE = 'parties_history_v2';

const COLUMNS = `id, tenant_id, name, kind, email, phone, vat_id, status, created_at`;

interface PartyRow {
	id: string;
	tenant_id: string;
	name: string;
	kind: Party['kind'];
	email: string | null;
	phone: string | null;
	vat_id: string | null;
	status: Party['status'];
	created_at: number;
}

function fromRow(row: PartyRow): Party {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		name: row.name,
		kind: row.kind,
		email: row.email,
		phone: row.phone,
		vatId: row.vat_id,
		status: row.status,
		createdAt: row.created_at,
	};
}

/* The fields a history version reports on. Identity, tenancy, and creation
   time are not changeable and are never part of a diff. */
function tracked(party: Party): TrackedFields {
	return {
		name: party.name,
		kind: party.kind,
		email: party.email,
		phone: party.phone,
		vatId: party.vatId,
		status: party.status,
	};
}

export class SqlitePartyRepository implements PartyRepository {
	readonly #database: DatabaseSync;
	#closed = false;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5000 });
		this.#database.exec('PRAGMA journal_mode = WAL;');
		runModuleMigrations(this.#database, migrations);
	}

	list(tenantId: string): readonly Party[] {
		return (
			this.#database
				.prepare(
					`SELECT ${COLUMNS}
					 FROM parties WHERE tenant_id = ?
					 ORDER BY lower(name), id`,
				)
				.all(tenantId) as unknown as PartyRow[]
		).map(fromRow);
	}

	create(party: Party, actor: Actor): Party {
		return inTransaction(this.#database, () => this.#insert(party, actor));
	}

	createIdempotent(
		party: Party,
		actor: Actor,
		idempotency: TargetIdempotencyRequest,
	): Party {
		return inTransaction(this.#database, () => {
			const existing = this.#idempotencyEntry(party.tenantId, idempotency.key);
			if (existing) {
				if (
					existing.operationId !== idempotency.operationId ||
					existing.inputDigest !== idempotency.inputDigest
				) {
					throw new TargetIdempotencyConflictError();
				}
				return this.#result(existing, party.tenantId);
			}

			const created = this.#insert(party, actor);
			const resultJson = JSON.stringify(created);
			this.#database
				.prepare(
					`INSERT INTO parties_idempotency_ledger
					 (id, tenant_id, idempotency_key, operation_id, input_digest,
					  outcome, result_json, result_digest, created_at)
					 VALUES (?, ?, ?, ?, ?, 'succeeded', ?, ?, ?)`,
				)
				.run(
					randomUUID(),
					party.tenantId,
					idempotency.key,
					idempotency.operationId,
					idempotency.inputDigest,
					resultJson,
					canonicalDigest(created),
					Date.now(),
				);
			return created;
		});
	}

	update(
		tenantId: string,
		input: UpdatePartyInput,
		actor: Actor,
	): Party | null {
		return inTransaction(this.#database, () => {
			const before = this.#find(tenantId, input.id);
			if (!before) return null;
			const row = this.#database
				.prepare(
					`UPDATE parties
					 SET name = ?, kind = ?, email = ?, phone = ?, vat_id = ?
					 WHERE tenant_id = ? AND id = ?
					 RETURNING ${COLUMNS}`,
				)
				.get(
					input.name,
					input.kind,
					input.email ?? null,
					input.phone ?? null,
					input.vatId ?? null,
					tenantId,
					input.id,
				) as unknown as PartyRow | undefined;
			if (!row) return null;
			const after = fromRow(row);
			const changes = diffFields(tracked(before), tracked(after));
			if (Object.keys(changes).length > 0) {
				appendHistory(this.#database, HISTORY_TABLE, {
					tenantId,
					recordId: after.id,
					action: 'updated',
					actor,
					changes,
					occurredAt: Date.now(),
				});
			}
			return after;
		});
	}

	setStatus(
		tenantId: string,
		id: string,
		status: Party['status'],
		actor: Actor,
	): Party | null {
		return inTransaction(this.#database, () => {
			const before = this.#find(tenantId, id);
			if (!before) return null;
			const row = this.#database
				.prepare(
					`UPDATE parties SET status = ? WHERE tenant_id = ? AND id = ?
					 RETURNING ${COLUMNS}`,
				)
				.get(status, tenantId, id) as unknown as PartyRow | undefined;
			if (!row) return null;
			const after = fromRow(row);
			if (before.status !== after.status) {
				appendHistory(this.#database, HISTORY_TABLE, {
					tenantId,
					recordId: id,
					action: status === 'archived' ? 'archived' : 'restored',
					actor,
					changes: diffFields(tracked(before), tracked(after)),
					occurredAt: Date.now(),
				});
			}
			return after;
		});
	}

	delete(tenantId: string, id: string, actor: Actor): boolean {
		return inTransaction(this.#database, () => {
			const before = this.#find(tenantId, id);
			if (!before) return false;
			appendHistory(this.#database, HISTORY_TABLE, {
				tenantId,
				recordId: id,
				action: 'deleted',
				actor,
				changes: diffFields(tracked(before), {
					name: null,
					kind: null,
					email: null,
					phone: null,
					vatId: null,
					status: null,
				}),
				occurredAt: Date.now(),
			});
			return (
				this.#database
					.prepare('DELETE FROM parties WHERE tenant_id = ? AND id = ?')
					.run(tenantId, id).changes === 1
			);
		});
	}

	history(query: HistoryQuery): HistoryPage {
		return queryHistory(this.#database, HISTORY_TABLE, query);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#database.close();
	}

	#find(tenantId: string, id: string): Party | null {
		const row = this.#database
			.prepare(`SELECT ${COLUMNS} FROM parties WHERE tenant_id = ? AND id = ?`)
			.get(tenantId, id) as unknown as PartyRow | undefined;
		return row ? fromRow(row) : null;
	}

	#insert(party: Party, actor: Actor): Party {
		this.#database
			.prepare(
				`INSERT INTO parties
				 (id, tenant_id, name, kind, email, phone, vat_id, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				party.id,
				party.tenantId,
				party.name,
				party.kind,
				party.email,
				party.phone,
				party.vatId,
				party.status,
				party.createdAt,
			);
		appendHistory(this.#database, HISTORY_TABLE, {
			tenantId: party.tenantId,
			recordId: party.id,
			action: 'created',
			actor,
			changes: diffFields(null, tracked(party)),
			occurredAt: party.createdAt,
		});
		return party;
	}

	#idempotencyEntry(
		tenantId: string,
		key: string,
	): TargetIdempotencyEntry | null {
		const row = this.#database
			.prepare(
				`SELECT operation_id, input_digest, result_json, result_digest
				 FROM parties_idempotency_ledger
				 WHERE tenant_id = ? AND idempotency_key = ?`,
			)
			.get(tenantId, key) as
			| {
					operation_id: string;
					input_digest: string;
					result_json: string;
					result_digest: string;
			  }
			| undefined;
		return row
			? {
					operationId: row.operation_id,
					inputDigest: row.input_digest,
					resultJson: row.result_json,
					resultDigest: row.result_digest,
				}
			: null;
	}

	#result(entry: TargetIdempotencyEntry, tenantId: string): Party {
		let result: Party;
		try {
			result = JSON.parse(entry.resultJson) as Party;
		} catch {
			throw new TargetIdempotencyCorruptionError();
		}
		if (
			result.tenantId !== tenantId ||
			canonicalDigest(result) !== entry.resultDigest
		)
			throw new TargetIdempotencyCorruptionError();
		return result;
	}
}
