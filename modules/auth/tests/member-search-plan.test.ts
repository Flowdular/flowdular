import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { TENANT_MEMBER_SEARCH_SQL } from '../src/services/database-repository.ts';
import {
	closeAuthTestDatabases,
	createAuthTestDatabase,
	type AuthTestDatabase,
} from './support/database.ts';

const TENANT = 'tenant-plan';
/* Enough members that reading the workspace is the expensive plan, and enough
   for the planner to have statistics it can act on. */
const MEMBERS = 5000;

let database: AuthTestDatabase | undefined;

afterEach(async () => {
	await database?.dispose();
	database = undefined;
});

afterAll(closeAuthTestDatabases);

/** A workspace of MEMBERS look-alike members plus one distinctive member. */
async function workspace(): Promise<AuthTestDatabase> {
	const opened = await createAuthTestDatabase();
	database = opened;
	await opened.runtime.transaction(
		async (transaction) => {
			await transaction.execute({
				text: `INSERT INTO auth_tenants (id, name, slug, created_at)
				       VALUES ($1, 'Plan', 'plan', 1)`,
				parameters: [TENANT],
			});
			await transaction.execute({
				text: `INSERT INTO auth_accounts
				       (id, email, email_normalized, password_hash, display_name,
				        status, created_at)
				       SELECT 'plan-' || g, 'member' || g || '@example.com',
				              'member' || g || '@example.com', '!', 'Member ' || g,
				              'active', g
				       FROM generate_series(1, $1) AS g`,
				parameters: [MEMBERS],
			});
			await transaction.execute({
				text: `INSERT INTO auth_accounts
				       (id, email, email_normalized, password_hash, display_name,
				        status, created_at)
				       VALUES ('plan-rare', 'zenobia@example.com',
				               'zenobia@example.com', '!', 'Zenobia Quartermain',
				               'active', 1)`,
			});
			await transaction.execute({
				text: `INSERT INTO auth_memberships
				       (account_id, tenant_id, role, created_at)
				       SELECT id, $1, 'member', 1 FROM auth_accounts`,
				parameters: [TENANT],
			});
		},
		{ access: 'write', tenantId: TENANT },
	);
	/* The planner acts on statistics, and nothing has collected any yet.
	   ANALYZE is maintenance, so it runs on the migration lease. */
	const lease = await opened.provider.acquire({
		namespace: 'auth.core',
		purpose: 'migration',
	});
	try {
		await lease.database.execute({
			text: 'ANALYZE auth_accounts, auth_memberships',
		});
	} finally {
		await lease.release();
	}
	return opened;
}

/**
 * The plan of the statement `DatabaseAuthRepository.searchTenantMembers` runs,
 * on the connection it runs it on: the runtime role, subject to the forced row
 * security of auth_memberships. The repository exports the statement text, so a
 * predicate or an ordering that drifts away from the indexes it was written for
 * is what this explains rather than a copy that stayed behind.
 */
async function searchPlan(
	opened: AuthTestDatabase,
	term: string,
): Promise<string> {
	const explained = await opened.runtime.transaction(
		(transaction) =>
			transaction.query<{ 'QUERY PLAN': string }>({
				text: 'EXPLAIN ' + TENANT_MEMBER_SEARCH_SQL,
				parameters: [TENANT, `${term}%`, 500],
			}),
		{ access: 'read', tenantId: TENANT },
	);
	return explained.rows.map((row) => row['QUERY PLAN']).join('\n');
}

describe('member search plan', () => {
	it('answers a term from the prefix index instead of reading the workspace', async () => {
		const opened = await workspace();

		const plan = await searchPlan(opened, 'zenobia');

		expect(plan).toContain('auth_accounts_display_name_prefix_idx');
		expect(plan).not.toContain('Seq Scan on auth_accounts');
	});

	it('reaches the same member the search answers', async () => {
		const opened = await workspace();

		expect(
			(await opened.repository.searchTenantMembers(TENANT, 'zenobia', 500)).map(
				(member) => member.email,
			),
		).toEqual(['zenobia@example.com']);
	});
});
