import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalListPage } from '../src/domain/types.ts';
import { listStatement } from '../src/services/database-repository.ts';
import type { ApprovalRequestFilters } from '../src/services/repository.ts';
import {
	openApprovalsTestDatabase,
	type ApprovalsTestDatabase,
} from './support/database.ts';

const TENANT = 'tenant-plan';
const DECIDER = 'account-decider';
const REQUESTER = 'account-requester';
/* Enough requests that reading the workspace is the expensive plan, and enough
   for the planner to have statistics it can act on. */
const REQUESTS = 5000;

let shared: ApprovalsTestDatabase;

beforeAll(async () => {
	shared = await openApprovalsTestDatabase();
	await shared.runtime.transaction(
		async (transaction) => {
			await transaction.execute({
				text: `INSERT INTO approvals_requests
				       (id, tenant_id, subject_module, subject_ref, permission, action,
				        title, summary, requester_account_id, requirement_json,
				        decisions_needed, status, expires_at, resolved_at, created_at)
				       SELECT 'plan-' || g, $1, 'catalog.core', 'product-' || g,
				              'catalog.products.manage', 'publish', 'Publish ' || g, NULL,
				              CASE WHEN g % 2 = 0 THEN $2 ELSE 'account-other' END,
				              '{"roleKey":"owner","scope":null,"decisions":1,"expiresInDays":7}',
				              1, CASE WHEN g % 3 = 0 THEN 'approved' ELSE 'pending' END,
				              g + 1000, NULL, g
				       FROM generate_series(1, $3) AS g`,
				parameters: [TENANT, REQUESTER, REQUESTS],
			});
			await transaction.execute({
				text: `INSERT INTO approvals_eligible (tenant_id, request_id, account_id)
				       SELECT $1, id, $2 FROM approvals_requests WHERE tenant_id = $1`,
				parameters: [TENANT, DECIDER],
			});
		},
		{ access: 'write', tenantId: TENANT },
	);
	/* The planner acts on statistics, and nothing has collected any yet.
	   ANALYZE is maintenance, so it runs on the migration lease. */
	const lease = await shared.databases.acquire({
		namespace: 'approvals.core',
		purpose: 'migration',
	});
	try {
		await lease.database.execute({
			text: 'ANALYZE approvals_requests, approvals_eligible',
		});
	} finally {
		await lease.release();
	}
});

afterAll(async () => {
	await shared?.dispose();
});

/**
 * The plan of the statement `DatabaseApprovalsRepository.listPage` runs, on
 * the connection it runs it on: the runtime role under the forced row security
 * of approvals_requests.
 */
async function plan(
	filters: ApprovalRequestFilters,
	page: Partial<ApprovalListPage> = {},
): Promise<string> {
	const statement = listStatement(TENANT, filters, {
		limit: 50,
		sort: 'createdAt',
		direction: 'desc',
		after: null,
		...page,
	});
	const explained = await shared.runtime.transaction(
		(transaction) =>
			transaction.query<{ 'QUERY PLAN': string }>({
				text: 'EXPLAIN ' + statement.text,
				...(statement.parameters ? { parameters: statement.parameters } : {}),
			}),
		{ access: 'read', tenantId: TENANT },
	);
	return explained.rows.map((row) => row['QUERY PLAN']).join('\n');
}

describe('APPROVALS-INBOX-PAGE plan', () => {
	it('walks a keyset index in order for the default page instead of sorting the workspace', async () => {
		const decidable = await plan({ decidableBy: DECIDER });
		expect(decidable).toContain('approvals_requests_created_idx');
		expect(decidable).not.toContain('Sort');

		const continued = await plan(
			{ decidableBy: DECIDER },
			{ after: { createdAt: 2500, id: 'plan-2500' } },
		);
		expect(continued).toContain('approvals_requests_created_idx');
		expect(continued).not.toContain('Sort');

		const ascending = await plan(
			{ decidableBy: DECIDER },
			{ direction: 'asc' },
		);
		expect(ascending).toContain('approvals_requests_created_idx');
		expect(ascending).not.toContain('Sort');
	});

	it('walks the status and requester keyset indexes under those filters', async () => {
		const pending = await plan({ status: 'pending', decidableBy: DECIDER });
		expect(pending).toContain('approvals_requests_status_created_idx');
		expect(pending).not.toContain('Sort');

		const mine = await plan({ requesterAccountId: REQUESTER });
		expect(mine).toContain('approvals_requests_requester_created_idx');
		expect(mine).not.toContain('Sort');
	});
});
