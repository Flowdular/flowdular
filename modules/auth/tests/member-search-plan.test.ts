import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
	TENANT_MEMBER_SEARCH_SQL,
	tenantMemberSortedStatement,
} from '../src/services/database-repository.ts';
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

/** The plan of the sorted member page, on the same connection and under the same policy. */
async function sortedPlan(
	opened: AuthTestDatabase,
	sort: 'displayName' | 'email',
	after: { sortValue: string; accountId: string } | null,
): Promise<string> {
	const statement = tenantMemberSortedStatement(TENANT, {
		sort,
		direction: 'asc',
		limit: 50,
		term: null,
		membershipStatus: null,
		after,
	});
	const explained = await opened.runtime.transaction(
		(transaction) =>
			transaction.query<{ 'QUERY PLAN': string }>({
				text: 'EXPLAIN ' + statement.text,
				...(statement.parameters ? { parameters: statement.parameters } : {}),
			}),
		{ access: 'read', tenantId: TENANT },
	);
	return explained.rows.map((row) => row['QUERY PLAN']).join('\n');
}

describe('sorted member page plan', () => {
	it('walks the sort index in order instead of sorting the workspace', async () => {
		const opened = await workspace();

		const first = await sortedPlan(opened, 'displayName', null);
		expect(first).toContain('auth_accounts_display_name_keyset_idx');
		expect(first).not.toContain('Sort');

		const continued = await sortedPlan(opened, 'displayName', {
			sortValue: 'member 2500',
			accountId: 'plan-2500',
		});
		expect(continued).toContain('auth_accounts_display_name_keyset_idx');
		expect(continued).not.toContain('Sort');

		const byEmail = await sortedPlan(opened, 'email', null);
		expect(byEmail).toContain('auth_accounts_email_keyset_idx');
		expect(byEmail).not.toContain('Sort');
	});
});

describe('member search plan', () => {
	it('answers a term from the prefix index instead of reading the workspace', async () => {
		const opened = await workspace();

		const plan = await searchPlan(opened, 'zenobia');

		/* The embedded database collates in C, where 0033's plain btree over
		   lower(display_name) answers the prefix range as well as 0028's
		   text_pattern_ops one and the planner picks either; a deployment with a
		   locale collation has only the prefix index for this range. */
		expect(plan).toMatch(/auth_accounts_display_name_(prefix|keyset)_idx/);
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
