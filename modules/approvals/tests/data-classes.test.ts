import { createDataClassRegistry } from '@flowdular/kernel';
import type { DataClassDeclaration } from '@flowdular/kernel';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	ERASED_ACCOUNT_PREFIX,
	ERASED_DECISION_COMMENT,
} from '../src/domain/types.ts';
import {
	REQUEST_RETENTION_DAYS,
	approvalsDataClasses,
} from '../src/services/data-classes.ts';
import {
	openApprovalsTestDatabase,
	type ApprovalsTestDatabase,
} from './support/database.ts';
import {
	createHarness,
	DAY_MS,
	member,
	OWNER_ROLE,
} from './support/harness.ts';

const TENANT = 'tenant-classes';
const OTHER = 'tenant-other';
const ADA = 'account-ada';
const BO = 'account-bo';
const CY = 'account-cy';
const SEPTEMBER = Date.UTC(2026, 8, 11, 9, 30, 0);

let shared: ApprovalsTestDatabase;

beforeAll(async () => {
	shared = await openApprovalsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

/** The service at a fixed moment, so every seeded row carries a known time. */
function service(at: number) {
	return createHarness({
		repository: shared.repository,
		members: [
			member(ADA, OWNER_ROLE),
			member(BO, OWNER_ROLE),
			member(CY, OWNER_ROLE),
		],
		now: () => at,
	}).service;
}

async function open(
	tenantId: string,
	subjectRef: string,
	requester: string,
	at: number,
	decisions = 1,
): Promise<string> {
	return (
		await service(at).open({
			tenantId,
			subjectModule: 'catalog.core',
			subjectRef,
			permission: 'catalog.products.manage',
			action: 'publish',
			title: `Publish ${subjectRef}`,
			summary: `Asked for ${subjectRef}.`,
			requesterAccountId: requester,
			requirement: { roleKey: OWNER_ROLE, decisions },
		})
	).id;
}

/** One request opened and answered, so it carries eligibility and a ledger. */
async function resolved(
	tenantId: string,
	subjectRef: string,
	requester: string,
	decider: string,
	at: number,
	comment = `Agreed on ${subjectRef}.`,
): Promise<string> {
	const id = await open(tenantId, subjectRef, requester, at);
	await service(at).decide(tenantId, id, decider, 'approve', comment);
	return id;
}

function declared(pageSize?: number): DataClassDeclaration {
	const registry = createDataClassRegistry();
	registry.declare(
		'approvals.core',
		pageSize === undefined
			? approvalsDataClasses(async () => shared.repository)
			: approvalsDataClasses(async () => shared.repository, pageSize),
	);
	const declaration = registry
		.list()
		.find((module) => module.moduleId === 'approvals.core')
		?.classes.find((item) => item.key === 'requests');
	if (!declaration) {
		throw new Error('approvals.core declared no requests class.');
	}
	return declaration;
}

async function exported(
	tenantId: string,
	pageSize?: number,
): Promise<readonly Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	await declared(pageSize).export!({
		tenantId,
		sink: {
			write: async (row) => {
				rows.push(row);
			},
		},
	});
	return rows;
}

async function exportedIds(tenantId: string): Promise<readonly string[]> {
	return (await exported(tenantId)).map((row) => String(row['id'])).sort();
}

/** Rows one workspace holds in a table, read through its own tenant policy. */
async function count(table: string, tenantId: string): Promise<number> {
	const result = await shared.runtime.transaction(
		(transaction) =>
			transaction.query<{ total: number | string }>({
				text: `SELECT count(*) AS total FROM ${table}`,
			}),
		{ access: 'read', tenantId },
	);
	return Number(result.rows[0]?.total ?? 0);
}

interface StoredDecision {
	readonly decider_account_id: string | null;
	readonly comment: string | null;
}

async function storedDecisions(
	tenantId: string,
	requestId: string,
): Promise<readonly StoredDecision[]> {
	const result = await shared.runtime.transaction(
		(transaction) =>
			transaction.query<StoredDecision>({
				text: `SELECT decider_account_id, comment FROM approvals_decisions
				 WHERE request_id = $1 ORDER BY id`,
				parameters: [requestId],
			}),
		{ access: 'read', tenantId },
	);
	return result.rows;
}

async function storedEligible(
	tenantId: string,
	requestId: string,
): Promise<readonly string[]> {
	const result = await shared.runtime.transaction(
		(transaction) =>
			transaction.query<{ account_id: string }>({
				text: `SELECT account_id FROM approvals_eligible
				 WHERE request_id = $1 ORDER BY account_id`,
				parameters: [requestId],
			}),
		{ access: 'read', tenantId },
	);
	return result.rows.map((row) => row.account_id);
}

describe('approvals.core data classes', () => {
	it('APPROVALS-DATA-CLASSES declares the requests class with its retention', () => {
		const registry = createDataClassRegistry();
		registry.declare(
			'approvals.core',
			approvalsDataClasses(async () => shared.repository),
		);

		expect(
			registry
				.list()
				.flatMap((module) =>
					module.classes.map((declaration) => [
						`${module.moduleId}.${declaration.key}`,
						declaration.defaultRetentionDays,
						declaration.exportable,
						Boolean(declaration.sweep),
						Boolean(declaration.erase),
						Boolean(declaration.count),
					]),
				),
		).toEqual([
			[
				'approvals.core.requests',
				REQUEST_RETENTION_DAYS,
				true,
				true,
				true,
				true,
			],
		]);
	});

	it('APPROVALS-DATA-CLASSES sweeps resolved requests older than the cutoff in one workspace only', async () => {
		await resolved(TENANT, 'old', ADA, BO, SEPTEMBER - 3 * DAY_MS);
		await resolved(TENANT, 'cutoff', ADA, BO, SEPTEMBER - DAY_MS);
		const pending = await open(TENANT, 'open', ADA, SEPTEMBER - 9 * DAY_MS);
		const foreign = await resolved(
			OTHER,
			'foreign',
			ADA,
			BO,
			SEPTEMBER - 3 * DAY_MS,
		);

		const removed = await declared().sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER - DAY_MS),
			limit: 100,
		});

		/* The request resolved exactly on the cutoff stays, which is what
		   "strictly older" means, and the pending one stays however old it is. */
		expect(removed).toEqual({ removed: 1 });
		expect((await exportedIds(TENANT)).length).toBe(2);
		expect(await exportedIds(TENANT)).toContain(pending);
		expect(await exportedIds(OTHER)).toEqual([foreign]);
	});

	it('takes the eligibility snapshot and the ledger of a swept request with it', async () => {
		await resolved(TENANT, 'old', ADA, BO, SEPTEMBER);
		expect(await count('approvals_eligible', TENANT)).toBe(2);
		expect(await count('approvals_decisions', TENANT)).toBe(1);

		await declared().sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER + DAY_MS),
			limit: 10,
		});

		for (const table of [
			'approvals_requests',
			'approvals_eligible',
			'approvals_decisions',
		]) {
			expect([table, await count(table, TENANT)]).toEqual([table, 0]);
		}
	});

	it('removes no more requests than the limit it was given', async () => {
		for (let offset = 0; offset < 3; offset += 1) {
			await resolved(
				TENANT,
				`request-${offset}`,
				ADA,
				BO,
				SEPTEMBER - offset * DAY_MS,
			);
		}

		const removed = await declared().sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER + DAY_MS),
			limit: 2,
		});

		expect(removed).toEqual({ removed: 2 });
		expect(await exportedIds(TENANT)).toHaveLength(1);
	});

	it('APPROVALS-DATA-CLASSES exports one workspace with its ledger and time range', async () => {
		await resolved(
			TENANT,
			'old',
			ADA,
			BO,
			SEPTEMBER - 2 * DAY_MS,
			'Fine by me.',
		);
		await open(TENANT, 'new', ADA, SEPTEMBER);
		await resolved(OTHER, 'foreign', ADA, BO, SEPTEMBER);
		const rows: Record<string, unknown>[] = [];

		const summary = await declared().export!({
			tenantId: TENANT,
			sink: {
				write: async (row) => {
					rows.push(row);
				},
			},
		});

		expect(summary.rows).toBe(2);
		expect(summary.from?.toISOString()).toBe(
			new Date(SEPTEMBER - 2 * DAY_MS).toISOString(),
		);
		expect(summary.to?.toISOString()).toBe(new Date(SEPTEMBER).toISOString());
		expect(rows.every((row) => row['tenantId'] === TENANT)).toBe(true);
		const answered = rows.find((row) => row['subjectRef'] === 'old');
		expect(answered).toMatchObject({
			status: 'approved',
			title: 'Publish old',
			summary: 'Asked for old.',
			requesterAccountId: ADA,
			createdAt: new Date(SEPTEMBER - 2 * DAY_MS).toISOString(),
		});
		expect(answered!['decisions']).toEqual([
			{
				id: expect.any(String),
				deciderAccountId: BO,
				decision: 'approve',
				comment: 'Fine by me.',
				decidedAt: new Date(SEPTEMBER - 2 * DAY_MS).toISOString(),
			},
		]);
		expect(rows.find((row) => row['subjectRef'] === 'new')).toMatchObject({
			status: 'pending',
			resolvedAt: null,
			decisions: [],
		});
	});

	it('walks the request export in keyset pages rather than one query', async () => {
		for (let offset = 0; offset < 5; offset += 1) {
			await resolved(
				TENANT,
				`request-${offset}`,
				ADA,
				BO,
				SEPTEMBER - offset * DAY_MS,
			);
		}

		const rows = await exported(TENANT, 2);

		expect(new Set(rows.map((row) => row['id'])).size).toBe(5);
	});

	it('exports nothing and reports no range for a workspace that holds none', async () => {
		await resolved(TENANT, 'old', ADA, BO, SEPTEMBER);

		expect(
			await declared().export!({
				tenantId: 'tenant-empty',
				sink: { write: async () => undefined },
			}),
		).toEqual({ rows: 0, from: null, to: null });
	});

	it('APPROVALS-DATA-CLASSES erases the resolved requests a subject opened and redacts the decisions they made elsewhere', async () => {
		const own = await resolved(TENANT, 'own', ADA, BO, SEPTEMBER);
		const stillOpen = await open(TENANT, 'own-open', ADA, SEPTEMBER);
		const others = await resolved(
			TENANT,
			'others',
			BO,
			ADA,
			SEPTEMBER,
			'I agree.',
		);
		const foreign = await resolved(OTHER, 'foreign', ADA, BO, SEPTEMBER);

		const result = await declared().erase!({
			tenantId: TENANT,
			subject: { accountId: ADA },
			limit: 100,
		});

		/* One request removed, one decision redacted and the eligibility row that
		   let the subject answer that request tombstoned, so the batch cleared
		   three rows without shortening anybody's ledger or snapshot. */
		expect(result).toEqual({ removed: 3 });
		expect(await exportedIds(TENANT)).toEqual([others, stillOpen].sort());
		expect(await exportedIds(OTHER)).toEqual([foreign]);
		expect(await count('approvals_decisions', TENANT)).toBe(1);

		const ledger = await storedDecisions(TENANT, others);
		expect(ledger).toHaveLength(1);
		expect(ledger[0]?.comment).toBe(ERASED_DECISION_COMMENT);
		expect(
			ledger[0]?.decider_account_id?.startsWith(ERASED_ACCOUNT_PREFIX),
		).toBe(true);
		expect(ledger[0]?.decider_account_id).not.toBe(ADA);
		/* The request the subject opened and nobody has answered is not resolved,
		   so the erasure leaves it exactly where the sweep would. */
		expect(await count('approvals_requests', TENANT)).toBe(2);
		expect(own).not.toBe(stillOpen);
	});

	/* approvals_decisions_decider_idx is unique per request and decider for an
	   approval, so erasing two people who answered the same request is what a
	   single fixed tombstone would fail on. */
	it('erases two people who answered the same request, one after the other', async () => {
		const id = await open(TENANT, 'shared', CY, SEPTEMBER, 2);
		await service(SEPTEMBER).decide(
			TENANT,
			id,
			ADA,
			'approve',
			'Yes from Ada.',
		);
		await service(SEPTEMBER).decide(TENANT, id, BO, 'approve', 'Yes from Bo.');

		for (const accountId of [ADA, BO]) {
			await declared().erase!({
				tenantId: TENANT,
				subject: { accountId },
				limit: 100,
			});
		}

		const accounts = (await storedDecisions(TENANT, id)).map(
			(row) => row.decider_account_id,
		);
		expect(accounts).toHaveLength(2);
		expect(new Set(accounts).size).toBe(2);
		expect(
			accounts.every((account) => account?.startsWith(ERASED_ACCOUNT_PREFIX)),
		).toBe(true);
	});

	it('APPROVALS-DATA-CLASSES tombstones the subject in a pending request opened by somebody else and leaves it decidable', async () => {
		const pending = await open(TENANT, 'others-pending', BO, SEPTEMBER, 2);
		const before = await storedEligible(TENANT, pending);
		/* The requester is never in their own snapshot, so this one names the two
		   other members and the erasure has to reach the subject inside it. */
		expect([...before].sort()).toEqual([ADA, CY]);

		const result = await declared().erase!({
			tenantId: TENANT,
			subject: { accountId: ADA },
			limit: 100,
		});

		expect(result).toEqual({ removed: 1 });
		const after = await storedEligible(TENANT, pending);
		expect(after).toHaveLength(2);
		expect(after).toContain(CY);
		expect(after).not.toContain(ADA);
		expect(
			after.filter((account) => account.startsWith(ERASED_ACCOUNT_PREFIX)),
		).toHaveLength(1);
		/* The request goes on asking, the member who can still answer is still
		   recorded as able to, and the subject is not. */
		expect(await shared.repository.get(TENANT, pending)).toMatchObject({
			status: 'pending',
		});
		expect(await shared.repository.isSnapshotDecider(TENANT, pending, CY)).toBe(
			true,
		);
		expect(
			await shared.repository.isSnapshotDecider(TENANT, pending, ADA),
		).toBe(false);
		expect(await shared.repository.countDecidable(TENANT, CY)).toBe(1);
		expect(await shared.repository.countDecidable(TENANT, ADA)).toBe(0);
	});

	/* The snapshot is keyed by (tenant, request, account), so erasing two people
	   eligible for one request is what a single fixed tombstone would fail on. */
	it('tombstones two people eligible for the same request, one after the other', async () => {
		const pending = await open(TENANT, 'shared-eligible', BO, SEPTEMBER, 2);

		for (const accountId of [ADA, CY]) {
			await declared().erase!({
				tenantId: TENANT,
				subject: { accountId },
				limit: 100,
			});
		}

		const accounts = await storedEligible(TENANT, pending);
		expect(accounts).toHaveLength(2);
		expect(new Set(accounts).size).toBe(2);
		expect(
			accounts.every((account) => account.startsWith(ERASED_ACCOUNT_PREFIX)),
		).toBe(true);
	});

	it('reports an erasure batch that filled its limit as truncated', async () => {
		for (let index = 0; index < 3; index += 1) {
			await resolved(
				TENANT,
				`request-${index}`,
				ADA,
				BO,
				SEPTEMBER - index * DAY_MS,
			);
		}

		const first = await declared().erase!({
			tenantId: TENANT,
			subject: { accountId: ADA },
			limit: 2,
		});
		const second = await declared().erase!({
			tenantId: TENANT,
			subject: { accountId: ADA },
			limit: 2,
		});

		expect(first).toEqual({ removed: 2, truncated: true });
		expect(second).toEqual({ removed: 1 });
		expect(await exportedIds(TENANT)).toEqual([]);
	});

	it('APPROVALS-DATA-CLASSES counts every request the subject opened in any state', async () => {
		await resolved(TENANT, 'own', ADA, BO, SEPTEMBER);
		await open(TENANT, 'own-open', ADA, SEPTEMBER);
		await resolved(TENANT, 'others', BO, ADA, SEPTEMBER);
		await resolved(OTHER, 'foreign', ADA, BO, SEPTEMBER);

		expect(
			await declared().count!({
				tenantId: TENANT,
				subject: { accountId: ADA },
			}),
		).toBe(2);
		expect(
			await declared().count!({ tenantId: TENANT, subject: { accountId: BO } }),
		).toBe(1);
		expect(
			await declared().count!({ tenantId: TENANT, subject: { accountId: CY } }),
		).toBe(0);
	});
});
