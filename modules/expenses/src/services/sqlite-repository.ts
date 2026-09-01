import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExpensesClaim } from '../domain/types.ts';
import { EXPENSES_MIGRATION_001 } from './migration.ts';
import type {
	ExpenseClaimListQuery,
	ExpensesRepository,
} from './repository.ts';

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
		status: row.status,
		decisionComment: row.decision_comment,
		createdAt: row.created_at,
	};
}

export class SqliteExpensesRepository implements ExpensesRepository {
	readonly #database: DatabaseSync;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5000 });
		this.#database.exec('PRAGMA journal_mode = WAL;');
		this.#database.exec(EXPENSES_MIGRATION_001);
	}

	list(query: ExpenseClaimListQuery): readonly ExpensesClaim[] {
		if (query.includeApprovalQueue && query.status === 'submitted') {
			return this.#rows(
				`SELECT id, tenant_id, claimant_id, title, amount_minor, currency,
				 category, expense_date, note, status, decision_comment, created_at
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
				 category, expense_date, note, status, decision_comment, created_at
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
			 category, expense_date, note, status, decision_comment, created_at
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
				 category, expense_date, note, status, decision_comment, created_at
				 FROM expenses_claims
				 WHERE tenant_id = ? AND id = ?`,
			)
			.get(tenantId, id) as ExpensesClaimRow | undefined;
		return row ? fromRow(row) : null;
	}

	create(record: ExpensesClaim): ExpensesClaim {
		this.#database
			.prepare(
				`INSERT INTO expenses_claims
				 (id, tenant_id, claimant_id, title, amount_minor, currency,
				  category, expense_date, note, status, decision_comment, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				record.status,
				record.decisionComment,
				record.createdAt,
			);
		return record;
	}

	update(record: ExpensesClaim): ExpensesClaim {
		this.#database
			.prepare(
				`UPDATE expenses_claims SET title = ?, amount_minor = ?, currency = ?,
				 category = ?, expense_date = ?, note = ?, status = ?,
				 decision_comment = ? WHERE tenant_id = ? AND id = ?`,
			)
			.run(
				record.title,
				record.amountMinor,
				record.currency,
				record.category,
				record.expenseDate,
				record.note,
				record.status,
				record.decisionComment,
				record.tenantId,
				record.id,
			);
		return record;
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

	#rows(sql: string, ...parameters: (string | number | null)[]) {
		return (
			this.#database
				.prepare(sql)
				.all(...parameters) as unknown as ExpensesClaimRow[]
		).map(fromRow);
	}
}
