import type {
	DatabaseAdapterLease,
	DatabaseHandle,
	DatabaseProvider,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';

/**
 * A rollup table standing in for a provider module's own. reports.core owns no
 * table, so the tenant boundary can only be proved against a real one: this is
 * shaped like every tenant table the platform requires, with row-level security
 * enabled and forced and a policy bound to the transaction-local tenant id.
 */
export const FIXTURE_TABLE = 'reports_fixture_facts';

const CREATE = `
CREATE TABLE IF NOT EXISTS ${FIXTURE_TABLE} (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  day TEXT NOT NULL,
  amount BIGINT NOT NULL
);
ALTER TABLE ${FIXTURE_TABLE} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${FIXTURE_TABLE} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${FIXTURE_TABLE}_tenant_policy ON ${FIXTURE_TABLE}
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

const REQUIREMENTS = {
	dialectIds: [DATABASE_DIALECT_IDS.postgresql],
	capabilities: [
		DATABASE_CAPABILITY_IDS.ROW_LEVEL_SECURITY,
		DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
		DATABASE_CAPABILITY_IDS.TRANSACTIONS,
	],
} as const;

export interface ReportsTestDatabase {
	/** Tenant-scoped handle, the one a provider would read its rollup through. */
	readonly runtime: DatabaseHandle;
	/** Writes one fact inside the tenant's own transaction. */
	record(tenantId: string, day: string, amount: number): Promise<void>;
	/** Empties the fixture so one engine can serve a whole file. */
	reset(): Promise<void>;
	dispose(): Promise<void>;
}

/**
 * An embedded PostgreSQL with the real runtime role and forced row-level
 * security. Starting the engine costs about half a second, so open one per file
 * and `reset()` between cases rather than paying it per test.
 */
export async function openReportsTestDatabase(): Promise<ReportsTestDatabase> {
	const databases: DatabaseProvider = createPgliteTestProvider();
	const leases: DatabaseAdapterLease[] = [];
	try {
		/* The owner lease outlives the schema creation: only a role above
		   row-level security can empty the table between cases. */
		const owner = await databases.acquire({
			namespace: 'reports.core',
			purpose: 'migration',
			requirements: {
				dialectIds: REQUIREMENTS.dialectIds,
				capabilities: [
					DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
					DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
					DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
				],
			},
		});
		leases.push(owner);
		await owner.database.transaction(
			(transaction) => transaction.execute({ text: CREATE }),
			{ access: 'write' },
		);
		const runtime = await databases.acquire({
			namespace: 'reports.core',
			purpose: 'test',
			requirements: REQUIREMENTS,
		});
		leases.push(runtime);
		let sequence = 0;
		return {
			runtime: runtime.database,
			async record(tenantId, day, amount) {
				sequence += 1;
				await runtime.database.transaction(
					(transaction) =>
						transaction.execute({
							text: `INSERT INTO ${FIXTURE_TABLE} (id, tenant_id, day, amount)
							 VALUES ($1, $2, $3, $4)`,
							parameters: [`fact-${sequence}`, tenantId, day, amount],
						}),
					{ access: 'write', tenantId },
				);
			},
			async reset() {
				await owner.database.transaction(
					(transaction) =>
						transaction.execute({ text: `TRUNCATE ${FIXTURE_TABLE}` }),
					{ access: 'write' },
				);
			},
			async dispose() {
				for (const lease of leases.reverse()) await lease.release();
				await databases.dispose();
			},
		};
	} catch (error) {
		for (const lease of leases.reverse()) await lease.release();
		await databases.dispose();
		throw error;
	}
}
