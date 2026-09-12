import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ReportProvider } from '../src/domain/providers.ts';
import {
	FIXTURE_TABLE,
	openReportsTestDatabase,
	type ReportsTestDatabase,
} from './support/database.ts';
import { createHarness, principal, TEST_RANGE } from './support/harness.ts';

const USAGE = 'metering.usage.read';

let shared: ReportsTestDatabase;

beforeAll(async () => {
	shared = await openReportsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

/**
 * A provider shaped like the shipped ones: it reads its own table inside its
 * own tenant-scoped transaction, with the tenant reports.core handed it and
 * bound parameters for the range.
 */
function fixtureProvider(): ReportProvider {
	return {
		key: 'metering.usage',
		label: 'Usage',
		permission: USAGE,
		read: async ({ tenantId, range }) => {
			const result = await shared.runtime.transaction(
				(transaction) =>
					transaction.query<{ total: string | number | null }>({
						text: `SELECT COALESCE(SUM(amount), 0) AS total FROM ${FIXTURE_TABLE}
						 WHERE tenant_id = $1 AND day BETWEEN $2 AND $3`,
						parameters: [tenantId, range.from, range.to],
					}),
				{ access: 'read', tenantId },
			);
			return {
				tiles: [
					{
						key: 'total',
						label: 'Total',
						value: Number(result.rows[0]?.total ?? 0),
						unit: 'units',
					},
				],
			};
		},
	};
}

function service() {
	return createHarness({
		providers: [{ moduleId: 'metering.core', providers: [fixtureProvider()] }],
	}).service;
}

describe('REPORTS-TENANT-BOUNDARY', () => {
	it('reports only the workspace the principal is in', async () => {
		await shared.record('tenant-a', '2026-09-01', 7);
		await shared.record('tenant-a', '2026-09-02', 5);
		await shared.record('tenant-b', '2026-09-01', 999);

		const reports = service();
		const inA = await reports.read({
			principal: principal([USAGE], 'account-ada', 'tenant-a'),
			range: TEST_RANGE,
		});
		const inB = await reports.read({
			principal: principal([USAGE], 'account-ada', 'tenant-b'),
			range: TEST_RANGE,
		});

		expect(inA.reports[0]!.tiles[0]!.value).toBe(12);
		expect(inB.reports[0]!.tiles[0]!.value).toBe(999);
		expect(inA.unavailable).toEqual([]);
	});

	/* Even with the predicate dropped, the forced policy answers nothing: the
	   isolation is the database's, not the provider's SQL. */
	it('hides the rows of another workspace from a tenant-scoped read', async () => {
		await shared.record('tenant-b', '2026-09-01', 999);

		const rows = await shared.runtime.transaction(
			(transaction) =>
				transaction.query<{ id: string }>({
					text: `SELECT id FROM ${FIXTURE_TABLE}`,
				}),
			{ access: 'read', tenantId: 'tenant-a' },
		);

		expect(rows.rows).toEqual([]);
	});

	it('refuses a row written under another workspace identifier', async () => {
		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO ${FIXTURE_TABLE} (id, tenant_id, day, amount)
						 VALUES ('row-foreign', 'tenant-b', '2026-09-01', 1)`,
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			),
		).rejects.toThrow();
	});

	it('leaves the range outside the window uncounted', async () => {
		await shared.record('tenant-a', '2026-01-01', 400);
		await shared.record('tenant-a', '2026-09-01', 3);

		const page = await service().read({
			principal: principal([USAGE], 'account-ada', 'tenant-a'),
			range: TEST_RANGE,
		});

		expect(page.reports[0]!.tiles[0]!.value).toBe(3);
	});
});
