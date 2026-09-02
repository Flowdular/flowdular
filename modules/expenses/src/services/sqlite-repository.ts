import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
import type {
	ExpenseClaimHistoryAction,
	ExpensesClaim,
} from '../domain/types.ts';
import { migrations } from './migration.ts';
import type {
	ExpenseClaimListQuery,
	ExpensesRepository,
} from './repository.ts';

const HISTORY_TABLE = 'expenses_claims_history';

interface ExpensesClaimRow {
	id: string;
	tenant_id: string;
	claimant_id: string;
	title: string;
	amount_minor: number;
	currency: string;
	category: ExpensesClaim['category'];
	expense_date: string;
	note: string | null;
	note_template: string | null;
	status: ExpensesClaim['status'];
	decision_comment: string | null;
	created_at: number;
}

function fromRow(row: ExpensesClaimRow): ExpensesClaim {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		claimantId: row.claimant_id,
		title: row.title,
		name: row.title,
		amountMinor: row.amount_minor,
		currency: row.currency,
		category: row.category,
		expenseDate: row.expense_date,
		note: row.note,
		noteTemplate: row.note_template ?? row.note,
		status: row.status,
		decisionComment: row.decision_comment,
		createdAt: row.created_at,
	};
}

/* The fields a history version reports on. The decision comment is part of the
   claim and is recorded; identity, tenancy, claimant, and creation time cannot
   change and are never part of a diff. */
function tracked(claim: ExpensesClaim): TrackedFields {
	return {
		title: claim.title,
		amountMinor: claim.amountMinor,
		currency: claim.currency,
		category: claim.category,
		expenseDate: claim.expenseDate,
		note: claim.note,
		noteTemplate: claim.noteTemplate,
		status: claim.status,
		decisionComment: claim.decisionComment,
	};
}

export class SqliteExpensesRepository implements ExpensesRepository {
	readonly #database: DatabaseSync;
	#closed = false;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5000 });
		this.#database.exec('PRAGMA journal_mode = WAL;');
		runModuleMigrations(this.#database, migrations);
	}

	list(query: ExpenseClaimListQuery): readonly ExpensesClaim[] {
		if (query.includeApprovalQueue && query.status === 'submitted') {
			return this.#rows(
				`SELECT id, tenant_id, claimant_id, title, amount_minor, currency,
				 category, expense_date, note, note_template, status, decision_comment, created_at
				 FROM expenses_claims
				 WHERE tenant_id = ? AND status = ?
				 ORDER BY expense_date DESC, id`,
				query.tenantId,
				query.status,
			);
		}
		if (query.status !== null) {
			return this.#rows(
				`SELECT id, tenant_id, claimant_id, title, amount_minor, currency,
				 category, expense_date, note, note_template, status, decision_comment, created_at
				 FROM expenses_claims
				 WHERE tenant_id = ? AND claimant_id = ? AND status = ?
				 ORDER BY expense_date DESC, id`,
				query.tenantId,
				query.claimantId,
				query.status,
			);
		}
		return this.#rows(
			`SELECT id, tenant_id, claimant_id, title, amount_minor, currency,
			 category, expense_date, note, note_template, status, decision_comment, created_at
			 FROM expenses_claims
			 WHERE tenant_id = ? AND claimant_id = ?
			 ORDER BY expense_date DESC, id`,
			query.tenantId,
			query.claimantId,
		);
	}

	find(tenantId: string, id: string): ExpensesClaim | null {
		const row = this.#database
			.prepare(
				`SELECT id, tenant_id, claimant_id, title, amount_minor, currency,
				 category, expense_date, note, note_template, status, decision_comment, created_at
				 FROM expenses_claims
				 WHERE tenant_id = ? AND id = ?`,
			)
			.get(tenantId, id) as ExpensesClaimRow | undefined;
		return row ? fromRow(row) : null;
	}

	create(record: ExpensesClaim, actor: Actor): ExpensesClaim {
		return inTransaction(this.#database, () => {
			this.#database
				.prepare(
					`INSERT INTO expenses_claims
					 (id, tenant_id, claimant_id, title, amount_minor, currency,
					  category, expense_date, note, note_template, status, decision_comment, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					record.id,
					record.tenantId,
					record.claimantId,
					record.title,
					record.amountMinor,
					record.currency,
					record.category,
					record.expenseDate,
					record.note,
					record.noteTemplate,
					record.status,
					record.decisionComment,
					record.createdAt,
				);
			appendHistory(this.#database, HISTORY_TABLE, {
				tenantId: record.tenantId,
				recordId: record.id,
				action: 'created',
				actor,
				changes: diffFields(null, tracked(record)),
				occurredAt: record.createdAt,
			});
			return record;
		});
	}

	update(
		record: ExpensesClaim,
		action: ExpenseClaimHistoryAction,
		actor: Actor,
	): ExpensesClaim {
		return inTransaction(this.#database, () => {
			const before = this.find(record.tenantId, record.id);
			this.#database
				.prepare(
					`UPDATE expenses_claims SET title = ?, amount_minor = ?, currency = ?,
					 category = ?, expense_date = ?, note = ?, note_template = ?, status = ?,
					 decision_comment = ? WHERE tenant_id = ? AND id = ?`,
				)
				.run(
					record.title,
					record.amountMinor,
					record.currency,
					record.category,
					record.expenseDate,
					record.note,
					record.noteTemplate,
					record.status,
					record.decisionComment,
					record.tenantId,
					record.id,
				);
			const changes = before
				? diffFields(tracked(before), tracked(record))
				: {};
			if (Object.keys(changes).length > 0) {
				appendHistory(this.#database, HISTORY_TABLE, {
					tenantId: record.tenantId,
					recordId: record.id,
					action,
					actor,
					changes,
					occurredAt: Date.now(),
				});
			}
			return record;
		});
	}

	delete(tenantId: string, id: string, actor: Actor): boolean {
		return inTransaction(this.#database, () => {
			const before = this.find(tenantId, id);
			if (!before) return false;
			appendHistory(this.#database, HISTORY_TABLE, {
				tenantId,
				recordId: id,
				action: 'deleted',
				actor,
				changes: diffFields(tracked(before), {
					title: null,
					amountMinor: null,
					currency: null,
					category: null,
					expenseDate: null,
					note: null,
					noteTemplate: null,
					status: null,
					decisionComment: null,
				}),
				occurredAt: Date.now(),
			});
			this.#database
				.prepare('DELETE FROM expenses_claims WHERE tenant_id = ? AND id = ?')
				.run(tenantId, id);
			return true;
		});
	}

	history(query: HistoryQuery): HistoryPage {
		return queryHistory(this.#database, HISTORY_TABLE, query);
	}

	countAwaitingApproval(tenantId: string): number {
		const row = this.#database
			.prepare(
				`SELECT COUNT(*) AS count FROM expenses_claims
				 WHERE tenant_id = ? AND status = 'submitted'`,
			)
			.get(tenantId) as { count: number };
		return row.count;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#database.close();
	}

	#rows(sql: string, ...parameters: (string | number | null)[]) {
		return (
			this.#database
				.prepare(sql)
				.all(...parameters) as unknown as ExpensesClaimRow[]
		).map(fromRow);
	}
}
