import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	APPROVALS_TENANT_TABLES,
	openApprovalsTestDatabase,
	type ApprovalsTestDatabase,
} from './support/database.ts';
import { createHarness, member, OWNER_ROLE } from './support/harness.ts';

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

function service(tenantId: string) {
	return createHarness({
		repository: shared.repository,
		members: [
			member(`requester-${tenantId}`, OWNER_ROLE),
			member(`decider-${tenantId}`, OWNER_ROLE),
		],
	}).service;
}

async function seed(tenantId: string) {
	return service(tenantId).open({
		tenantId,
		subjectModule: 'catalog.core',
		subjectRef: `product-${tenantId}`,
		permission: 'catalog.products.manage',
		action: 'publish',
		title: `Publish for ${tenantId}`,
		requesterAccountId: `requester-${tenantId}`,
		requirement: { roleKey: OWNER_ROLE },
	});
}

describe('APPROVALS-TENANT-BOUNDARY', () => {
	it('APPROVALS-TENANT-BOUNDARY shows one workspace only its own requests and decisions', async () => {
		const alpha = await seed('tenant-alpha');
		const beta = await seed('tenant-beta');
		await service('tenant-alpha').decide(
			'tenant-alpha',
			alpha.id,
			'decider-tenant-alpha',
			'approve',
		);

		expect(
			(await service('tenant-alpha').list('tenant-alpha', {})).map(
				(entry) => entry.subjectRef,
			),
		).toEqual(['product-tenant-alpha']);
		expect(
			await service('tenant-alpha').get('tenant-alpha', beta.id),
		).toBeNull();
		expect(
			await service('tenant-alpha').detail('tenant-alpha', beta.id),
		).toBeNull();
		expect(
			(await service('tenant-beta').detail('tenant-beta', beta.id))?.decisions,
		).toHaveLength(0);
		expect(
			await service('tenant-beta').countDecidable(
				'tenant-beta',
				'decider-tenant-alpha',
			),
		).toBe(0);
	});

	it('APPROVALS-TENANT-BOUNDARY rejects a row carrying another workspace identifier', async () => {
		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO approvals_requests
						 (id, tenant_id, subject_module, subject_ref, permission, action,
						  title, summary, requester_account_id, requirement_json,
						  decisions_needed, status, expires_at, resolved_at, created_at)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, 1, 'pending',
						         $10, NULL, $11)`,
						parameters: [
							'smuggled',
							'tenant-beta',
							'catalog.core',
							'product-smuggled',
							'catalog.products.manage',
							'publish',
							'Smuggled',
							'requester-tenant-beta',
							'{"roleKey":"owner","scope":null,"decisions":1,"expiresInDays":7}',
							Date.now(),
							Date.now(),
						],
					}),
				{ access: 'write', tenantId: 'tenant-alpha' },
			),
		).rejects.toThrow();
	});

	it('APPROVALS-TENANT-BOUNDARY lets the expiry poll read routing columns only, across tenants', async () => {
		await seed('tenant-alpha');
		await seed('tenant-beta');

		const routing = await shared.repository.listDueExpiries(
			Date.now() + 400 * 24 * 60 * 60 * 1_000,
			10,
		);
		expect([...new Set(routing.map((entry) => entry.tenantId))].sort()).toEqual(
			['tenant-alpha', 'tenant-beta'],
		);
		expect(Object.keys(routing[0] ?? {}).sort()).toEqual([
			'expiresAt',
			'id',
			'status',
			'tenantId',
		]);

		for (const column of [
			'subject_ref',
			'requester_account_id',
			'requirement_json',
			'title',
		]) {
			await expect(
				shared.background.query({
					text: `SELECT ${column} FROM approvals_requests LIMIT 1`,
				}),
			).rejects.toThrow();
		}
	});

	it('APPROVALS-TENANT-BOUNDARY keeps every table no migration granted away from the background role', async () => {
		/* Only the request routing columns are granted; the eligibility snapshot
		   and the ledger stay invisible on that connection. */
		for (const table of APPROVALS_TENANT_TABLES.filter(
			(name) => name !== 'approvals_requests',
		)) {
			await expect(
				shared.background.query({ text: `SELECT 1 FROM ${table} LIMIT 1` }),
			).rejects.toThrow();
		}
	});
});
