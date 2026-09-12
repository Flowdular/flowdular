import type {
	DatabaseHandle,
	DatabaseParameter,
	DatabaseRow,
	DatabaseStatement,
	DatabaseTransaction,
} from '@flowdular/database';
import { runDatabaseMigrations } from '@flowdular/database';
import type {
	ApprovalDecision,
	ApprovalDecisionKind,
	ApprovalRequest,
	ApprovalRequestDetail,
	ApprovalRequirementRecord,
	ApprovalRouting,
	ApprovalStatus,
} from '../domain/types.ts';
import {
	ERASED_ACCOUNT_PREFIX,
	ERASED_DECISION_COMMENT,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type {
	ApprovalRequestFilters,
	ApprovalsRepository,
	CreateApprovalResult,
	DecideApprovalInput,
	DecideApprovalResult,
} from './repository.ts';

export interface ApprovalsDatabaseHandles {
	/** Tenant-scoped lease every request path runs on. */
	readonly runtime: DatabaseHandle;
	/** Cross-tenant read lease the expiry poll runs on. Routing columns only. */
	readonly background: DatabaseHandle;
}

interface RequestRow {
	id: string;
	tenant_id: string;
	subject_module: string;
	subject_ref: string;
	permission: string;
	action: string;
	title: string;
	summary: string | null;
	requester_account_id: string;
	requirement_json: string;
	decisions_needed: number | bigint | string;
	status: ApprovalStatus;
	expires_at: number | bigint | string;
	resolved_at: number | bigint | string | null;
	created_at: number | bigint | string;
}

interface DecisionRow {
	id: string;
	tenant_id: string;
	request_id: string;
	decider_account_id: string | null;
	decision: ApprovalDecisionKind;
	comment: string | null;
	decided_at: number | bigint | string;
}

interface RoutingRow {
	tenant_id: string;
	id: string;
	expires_at: number | bigint | string;
	status: ApprovalStatus;
}

const REQUEST_COLUMNS = `id, tenant_id, subject_module, subject_ref, permission,
	 action, title, summary, requester_account_id, requirement_json,
	 decisions_needed, status, expires_at, resolved_at, created_at`;

/* Queries stay explicit. Values always travel in the adapter's parameter
   channel; nothing from a request is concatenated into SQL. */
const SQL = {
	insertRequest: `INSERT INTO approvals_requests
	 (id, tenant_id, subject_module, subject_ref, permission, action, title,
	  summary, requester_account_id, requirement_json, decisions_needed, status,
	  expires_at, resolved_at, created_at)
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
	 ON CONFLICT DO NOTHING
	 RETURNING id`,
	pendingBySubject: `SELECT ${REQUEST_COLUMNS} FROM approvals_requests
	 WHERE tenant_id = $1 AND subject_module = $2 AND subject_ref = $3
	   AND status = 'pending'`,
	getRequest: `SELECT ${REQUEST_COLUMNS} FROM approvals_requests
	 WHERE tenant_id = $1 AND id = $2`,
	lockRequest: `SELECT ${REQUEST_COLUMNS} FROM approvals_requests
	 WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
	listRequests: `SELECT ${REQUEST_COLUMNS} FROM approvals_requests r
	 WHERE r.tenant_id = $1
	   AND ($2::text IS NULL OR r.status = $2)
	   AND ($3::text IS NULL OR r.subject_module = $3)
	   AND ($4::text IS NULL OR r.subject_ref = $4)
	   AND ($5::text IS NULL OR r.requester_account_id = $5)
	   AND ($6::text IS NULL OR EXISTS (
	     SELECT 1 FROM approvals_eligible e
	     WHERE e.tenant_id = r.tenant_id AND e.request_id = r.id
	       AND e.account_id = $6))
	 ORDER BY r.created_at DESC, r.id
	 LIMIT $7`,
	countDecidable: `SELECT count(*) AS total FROM approvals_requests r
	 WHERE r.tenant_id = $1 AND r.status = 'pending'
	   AND EXISTS (
	     SELECT 1 FROM approvals_eligible e
	     WHERE e.tenant_id = r.tenant_id AND e.request_id = r.id
	       AND e.account_id = $2)`,
	snapshotDecider: `SELECT 1 AS present FROM approvals_eligible
	 WHERE tenant_id = $1 AND request_id = $2 AND account_id = $3`,
	listDecisions: `SELECT id, tenant_id, request_id, decider_account_id,
	 decision, comment, decided_at FROM approvals_decisions
	 WHERE tenant_id = $1 AND request_id = $2
	 ORDER BY decided_at, id`,
	insertDecision: `INSERT INTO approvals_decisions
	 (id, tenant_id, request_id, decider_account_id, decision, comment, decided_at)
	 VALUES ($1, $2, $3, $4, $5, $6, $7)
	 ON CONFLICT DO NOTHING
	 RETURNING id`,
	resolveRequest: `UPDATE approvals_requests
	 SET status = $1, resolved_at = $2
	 WHERE tenant_id = $3 AND id = $4 AND status = 'pending'`,
	/* The one cross-tenant read. It returns routing columns only; the request
	   is read again under the tenant the routing row named before it expires. */
	dueExpiries: `SELECT tenant_id, id, expires_at, status FROM approvals_requests
	 WHERE status = 'pending' AND expires_at <= $1
	 ORDER BY expires_at, tenant_id, id
	 LIMIT $2`,
	/* The export walks approvals_requests_export_idx, so a request opened during
	   the walk lands ahead of the cursor rather than being visited twice. */
	exportRequests: `SELECT ${REQUEST_COLUMNS} FROM approvals_requests
	 WHERE tenant_id = $1 ORDER BY id LIMIT $2`,
	exportRequestsAfter: `SELECT ${REQUEST_COLUMNS} FROM approvals_requests
	 WHERE tenant_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
	exportDecisions: `SELECT id, tenant_id, request_id, decider_account_id,
	 decision, comment, decided_at FROM approvals_decisions
	 WHERE tenant_id = $1 AND request_id = ANY($2::text[])
	 ORDER BY request_id, decided_at, id`,
	/* The inner limit bounds the batch; the eligibility and decision rows of the
	   requests it names leave with them in the same transaction. */
	resolvedBefore: `SELECT id FROM approvals_requests
	 WHERE tenant_id = $1
	   AND status IN ('approved', 'rejected', 'expired', 'cancelled')
	   AND resolved_at < $2
	 ORDER BY resolved_at, id LIMIT $3`,
	resolvedOfRequester: `SELECT id FROM approvals_requests
	 WHERE tenant_id = $1 AND requester_account_id = $2
	   AND status IN ('approved', 'rejected', 'expired', 'cancelled')
	 ORDER BY created_at DESC, id LIMIT $3`,
	deleteEligibleOf: `DELETE FROM approvals_eligible
	 WHERE tenant_id = $1 AND request_id = ANY($2::text[])`,
	deleteDecisionsOf: `DELETE FROM approvals_decisions
	 WHERE tenant_id = $1 AND request_id = ANY($2::text[])`,
	deleteRequests: `DELETE FROM approvals_requests
	 WHERE tenant_id = $1 AND id = ANY($2::text[])`,
	/* PostgreSQL takes no LIMIT on an UPDATE, so the batch is chosen by the
	   inner select and the outer statement writes exactly the rows it named. */
	redactDecisions: `UPDATE approvals_decisions
	 SET comment = $1::text, decider_account_id = $2::text || id
	 WHERE tenant_id = $3 AND id IN (
	   SELECT id FROM approvals_decisions
	   WHERE tenant_id = $4 AND decider_account_id = $5
	   ORDER BY id LIMIT $6)
	 RETURNING id`,
	/* The snapshot has no row id to borrow and its key is the account itself, so
	   the marker carries a fresh value per row. It reaches a pending request as
	   well as a resolved one: the subject is leaving, and the people still able
	   to answer are the other rows, which this does not touch. */
	redactEligible: `UPDATE approvals_eligible
	 SET account_id = $1::text || gen_random_uuid()
	 WHERE tenant_id = $2 AND account_id = $3 AND request_id IN (
	   SELECT request_id FROM approvals_eligible
	   WHERE tenant_id = $4 AND account_id = $5
	   ORDER BY request_id LIMIT $6)
	 RETURNING request_id`,
	countRequestedBy: `SELECT count(*) AS total FROM approvals_requests
	 WHERE tenant_id = $1 AND requester_account_id = $2`,
} as const;

/* The adapter's own parameter channel plus the id list a batched statement
   binds to an ANY($n::text[]) predicate, which the scalar type does not cover. */
type StatementParameter = DatabaseParameter | readonly string[];

function integer(value: number | bigint | string, field: string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error(`The approvals database returned an invalid ${field}.`);
	}
	return normalized;
}

function optionalInteger(
	value: number | bigint | string | null,
	field: string,
): number | null {
	return value === null ? null : integer(value, field);
}

/* A stored requirement is this module's own JSON, written by
   `normalizeRequirement`. A row that cannot be read back is a corrupted row,
   not an input to validate. */
function requirementFrom(value: string): ApprovalRequirementRecord {
	const parsed = JSON.parse(value) as Partial<ApprovalRequirementRecord>;
	return {
		roleKey: typeof parsed.roleKey === 'string' ? parsed.roleKey : null,
		scope: typeof parsed.scope === 'string' ? parsed.scope : null,
		decisions: Number(parsed.decisions ?? 1),
		expiresInDays: Number(parsed.expiresInDays ?? 1),
	};
}

function requestFrom(row: RequestRow): ApprovalRequest {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		subjectModule: row.subject_module,
		subjectRef: row.subject_ref,
		permission: row.permission,
		action: row.action,
		title: row.title,
		summary: row.summary,
		requesterAccountId: row.requester_account_id,
		requirement: requirementFrom(row.requirement_json),
		decisionsNeeded: integer(row.decisions_needed, 'decisionsNeeded'),
		status: row.status,
		expiresAt: integer(row.expires_at, 'expiresAt'),
		resolvedAt: optionalInteger(row.resolved_at, 'resolvedAt'),
		createdAt: integer(row.created_at, 'createdAt'),
	};
}

function decisionFrom(row: DecisionRow): ApprovalDecision {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		requestId: row.request_id,
		deciderAccountId: row.decider_account_id,
		decision: row.decision,
		comment: row.comment,
		decidedAt: integer(row.decided_at, 'decidedAt'),
	};
}

export class DatabaseApprovalsRepository implements ApprovalsRepository {
	constructor(private readonly handles: ApprovalsDatabaseHandles) {}

	async #read<Row extends DatabaseRow>(
		tenantId: string,
		statement: DatabaseStatement,
	): Promise<readonly Row[]> {
		const result = await this.handles.runtime.transaction(
			(transaction) => transaction.query<Row>(statement),
			{ access: 'read', tenantId },
		);
		return result.rows;
	}

	async #query<Row extends DatabaseRow>(
		transaction: DatabaseTransaction,
		text: string,
		parameters: readonly StatementParameter[],
	): Promise<readonly Row[]> {
		return (
			await transaction.query<Row>({
				text,
				parameters: parameters as DatabaseParameter[],
			})
		).rows;
	}

	async #exec(
		transaction: DatabaseTransaction,
		text: string,
		parameters: readonly StatementParameter[],
	): Promise<void> {
		await transaction.execute({
			text,
			parameters: parameters as DatabaseParameter[],
		});
	}

	async create(
		request: ApprovalRequest,
		eligibleAccountIds: readonly string[],
	): Promise<CreateApprovalResult> {
		return this.handles.runtime.transaction(
			async (transaction) => {
				const inserted = await this.#query<{ id: string }>(
					transaction,
					SQL.insertRequest,
					[
						request.id,
						request.tenantId,
						request.subjectModule,
						request.subjectRef,
						request.permission,
						request.action,
						request.title,
						request.summary,
						request.requesterAccountId,
						JSON.stringify(request.requirement),
						request.decisionsNeeded,
						request.status,
						request.expiresAt,
						request.resolvedAt,
						request.createdAt,
					],
				);
				if (inserted.length === 0) {
					const open = await this.#query<RequestRow>(
						transaction,
						SQL.pendingBySubject,
						[request.tenantId, request.subjectModule, request.subjectRef],
					);
					const existing = open[0];
					if (!existing) {
						/* Nothing inserted and nothing pending means the primary key
						   collided, which a fresh identifier never does. */
						throw new Error('The approvals request could not be opened.');
					}
					return { request: requestFrom(existing), created: false };
				}
				/* The snapshot rows are written with the request, in the same
				   transaction: a request nobody is recorded as eligible for would be
				   a request nobody can see. */
				if (eligibleAccountIds.length > 0) {
					const values = eligibleAccountIds
						.map(
							(_, index) =>
								`($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`,
						)
						.join(', ');
					await this.#exec(
						transaction,
						`INSERT INTO approvals_eligible (tenant_id, request_id, account_id)
						 VALUES ${values}`,
						eligibleAccountIds.flatMap((accountId) => [
							request.tenantId,
							request.id,
							accountId,
						]),
					);
				}
				return { request, created: true };
			},
			{ access: 'write', tenantId: request.tenantId },
		);
	}

	async get(tenantId: string, id: string): Promise<ApprovalRequest | null> {
		const rows = await this.#read<RequestRow>(tenantId, {
			text: SQL.getRequest,
			parameters: [tenantId, id],
		});
		return rows[0] ? requestFrom(rows[0]) : null;
	}

	async findPendingBySubject(
		tenantId: string,
		subjectModule: string,
		subjectRef: string,
	): Promise<ApprovalRequest | null> {
		const rows = await this.#read<RequestRow>(tenantId, {
			text: SQL.pendingBySubject,
			parameters: [tenantId, subjectModule, subjectRef],
		});
		return rows[0] ? requestFrom(rows[0]) : null;
	}

	async detail(
		tenantId: string,
		id: string,
	): Promise<ApprovalRequestDetail | null> {
		return this.handles.runtime.transaction(
			async (transaction) => {
				const rows = await this.#query<RequestRow>(
					transaction,
					SQL.getRequest,
					[tenantId, id],
				);
				const row = rows[0];
				if (!row) return null;
				const decisions = await this.#query<DecisionRow>(
					transaction,
					SQL.listDecisions,
					[tenantId, id],
				);
				return {
					request: requestFrom(row),
					decisions: decisions.map(decisionFrom),
				};
			},
			{ access: 'read', tenantId },
		);
	}

	async list(
		tenantId: string,
		filters: ApprovalRequestFilters,
		limit: number,
	): Promise<readonly ApprovalRequest[]> {
		const rows = await this.#read<RequestRow>(tenantId, {
			text: SQL.listRequests,
			parameters: [
				tenantId,
				filters.status ?? null,
				filters.subjectModule ?? null,
				filters.subjectRef ?? null,
				filters.requesterAccountId ?? null,
				filters.decidableBy ?? null,
				limit,
			],
		});
		return rows.map(requestFrom);
	}

	async countDecidable(tenantId: string, accountId: string): Promise<number> {
		const rows = await this.#read<{ total: number | bigint | string }>(
			tenantId,
			{ text: SQL.countDecidable, parameters: [tenantId, accountId] },
		);
		return integer(rows[0]?.total ?? 0, 'decidable count');
	}

	async isSnapshotDecider(
		tenantId: string,
		requestId: string,
		accountId: string,
	): Promise<boolean> {
		const rows = await this.#read<{ present: number }>(tenantId, {
			text: SQL.snapshotDecider,
			parameters: [tenantId, requestId, accountId],
		});
		return rows.length > 0;
	}

	async decide(input: DecideApprovalInput): Promise<DecideApprovalResult> {
		return this.handles.runtime.transaction(
			async (transaction) => {
				/* Two deciders reaching the count at the same moment must not both
				   read one approval short of it, so the request row is the lock the
				   whole decision is taken under. */
				const locked = await this.#query<RequestRow>(
					transaction,
					SQL.lockRequest,
					[input.tenantId, input.requestId],
				);
				const row = locked[0];
				if (!row) return { outcome: 'not-found' } as const;
				const request = requestFrom(row);
				if (request.status !== 'pending') {
					return { outcome: 'not-pending', request } as const;
				}
				const appended = await this.#query<{ id: string }>(
					transaction,
					SQL.insertDecision,
					[
						input.decision.id,
						input.tenantId,
						input.requestId,
						input.decision.deciderAccountId,
						input.decision.decision,
						input.decision.comment,
						input.decision.decidedAt,
					],
				);
				if (appended.length === 0) {
					return { outcome: 'duplicate', request } as const;
				}
				const decisions = (
					await this.#query<DecisionRow>(transaction, SQL.listDecisions, [
						input.tenantId,
						input.requestId,
					])
				).map(decisionFrom);
				const terminal = input.resolve(decisions);
				if (!terminal) {
					return {
						outcome: 'recorded',
						request,
						decisions,
						resolved: false,
					} as const;
				}
				await this.#exec(transaction, SQL.resolveRequest, [
					terminal,
					input.resolvedAt,
					input.tenantId,
					input.requestId,
				]);
				return {
					outcome: 'recorded',
					request: {
						...request,
						status: terminal,
						resolvedAt: input.resolvedAt,
					},
					decisions,
					resolved: true,
				} as const;
			},
			{ access: 'write', tenantId: input.tenantId },
		);
	}

	async listDueExpiries(
		now: number,
		limit: number,
	): Promise<readonly ApprovalRouting[]> {
		const result = await this.handles.background.transaction(
			(transaction) =>
				transaction.query<RoutingRow>({
					text: SQL.dueExpiries,
					parameters: [now, limit],
				}),
			{ access: 'read' },
		);
		return result.rows.map((row) => ({
			tenantId: row.tenant_id,
			id: row.id,
			expiresAt: integer(row.expires_at, 'expiresAt'),
			status: row.status,
		}));
	}

	/* The operations behind the declared data class. Each runs on the runtime
	   lease, inside its own tenant-scoped transaction. */

	async exportRequestsPage(
		tenantId: string,
		afterId: string | null,
		limit: number,
	): Promise<readonly ApprovalRequestDetail[]> {
		return this.handles.runtime.transaction(
			async (transaction) => {
				const requests =
					afterId === null
						? await this.#query<RequestRow>(transaction, SQL.exportRequests, [
								tenantId,
								limit,
							])
						: await this.#query<RequestRow>(
								transaction,
								SQL.exportRequestsAfter,
								[tenantId, afterId, limit],
							);
				if (requests.length === 0) return [];
				/* Two queries for the whole page, and the ledger is bucketed by
				   request in one pass rather than filtered once per request. */
				const decisions = await this.#query<DecisionRow>(
					transaction,
					SQL.exportDecisions,
					[tenantId, requests.map((request) => request.id)],
				);
				const ledgers = new Map<string, ApprovalDecision[]>();
				for (const row of decisions) {
					const ledger = ledgers.get(row.request_id);
					if (ledger) ledger.push(decisionFrom(row));
					else ledgers.set(row.request_id, [decisionFrom(row)]);
				}
				return requests.map((row) => ({
					request: requestFrom(row),
					decisions: ledgers.get(row.id) ?? [],
				}));
			},
			{ access: 'read', tenantId },
		);
	}

	async deleteResolvedBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number> {
		return this.handles.runtime.transaction(
			async (transaction) => {
				const rows = await this.#query<{ id: string }>(
					transaction,
					SQL.resolvedBefore,
					[tenantId, before, limit],
				);
				return this.#deleteRequestsIn(transaction, tenantId, rows);
			},
			{ access: 'write', tenantId },
		);
	}

	async deleteResolvedRequestedBy(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number> {
		return this.handles.runtime.transaction(
			async (transaction) => {
				const rows = await this.#query<{ id: string }>(
					transaction,
					SQL.resolvedOfRequester,
					[tenantId, accountId, limit],
				);
				return this.#deleteRequestsIn(transaction, tenantId, rows);
			},
			{ access: 'write', tenantId },
		);
	}

	/* No foreign key hangs off a request, so the child rows are named here. A
	   request, its eligibility snapshot and its ledger leave in one transaction
	   or not at all. */
	async #deleteRequestsIn(
		transaction: DatabaseTransaction,
		tenantId: string,
		rows: readonly { readonly id: string }[],
	): Promise<number> {
		if (rows.length === 0) return 0;
		const ids = rows.map((row) => row.id);
		for (const statement of [SQL.deleteEligibleOf, SQL.deleteDecisionsOf]) {
			await this.#exec(transaction, statement, [tenantId, ids]);
		}
		await this.#exec(transaction, SQL.deleteRequests, [tenantId, ids]);
		return ids.length;
	}

	async redactDecisionsBy(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number> {
		return this.handles.runtime.transaction(
			async (transaction) =>
				(
					await this.#query<{ id: string }>(transaction, SQL.redactDecisions, [
						ERASED_DECISION_COMMENT,
						ERASED_ACCOUNT_PREFIX,
						tenantId,
						tenantId,
						accountId,
						limit,
					])
				).length,
			{ access: 'write', tenantId },
		);
	}

	async redactEligibilityOf(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number> {
		return this.handles.runtime.transaction(
			async (transaction) =>
				(
					await this.#query<{ request_id: string }>(
						transaction,
						SQL.redactEligible,
						[
							ERASED_ACCOUNT_PREFIX,
							tenantId,
							accountId,
							tenantId,
							accountId,
							limit,
						],
					)
				).length,
			{ access: 'write', tenantId },
		);
	}

	async countRequestedBy(tenantId: string, accountId: string): Promise<number> {
		const rows = await this.#read<{ total: number | bigint | string }>(
			tenantId,
			{ text: SQL.countRequestedBy, parameters: [tenantId, accountId] },
		);
		return integer(rows[0]?.total ?? 0, 'requested count');
	}
}

export async function migrateApprovalsDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'approvals.core', databaseMigrations);
}
