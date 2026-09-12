import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_PERMISSIONS } from '../src/acl/permissions.ts';
import type { AccessAttestation } from '../src/domain/types.ts';
import { moduleDefinition } from '../src/index.ts';
import { AccessService } from '../src/services/access-service.ts';
import { accessDataClasses } from '../src/services/data-classes.ts';
import type { AccessDirectory } from '../src/services/directory.ts';
import {
	openAccessTestDatabase,
	type AccessTestDatabase,
} from './support/database.ts';

let shared: AccessTestDatabase;

beforeAll(async () => {
	shared = await openAccessTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

const EMPTY_DIRECTORY: AccessDirectory = {
	members: async () => [],
	memberPage: async () => ({ members: [], nextCursor: null }),
	roles: async () => [],
	tokens: async () => [],
	providers: async () => [],
	auditPage: async () => [],
};

function service(now = () => 1_000): AccessService {
	return new AccessService({
		repository: shared.repository,
		directory: EMPTY_DIRECTORY,
		now,
	});
}

async function attest(
	tenantId: string,
	note: string,
	at: number,
): Promise<AccessAttestation> {
	return service(() => at).attest(
		tenantId,
		{ accountId: 'account-1', label: 'reviewer@example.com' },
		{
			window: { from: Date.UTC(2026, 5, 1), to: Date.UTC(2026, 5, 30) },
			note,
		},
	);
}

describe('access.core module identity', () => {
	it('declares the permissions its routes and navigation require', () => {
		expect(moduleDefinition.manifest.id).toBe('access.core');
		expect(moduleDefinition.permissions).toEqual([
			'access.review.read',
			'access.review.manage',
		]);
		expect(moduleDefinition.navigation[0]?.permission).toBe(
			ACCESS_PERMISSIONS.read,
		);
	});
});

describe('ACCESS-TENANT-BOUNDARY the database refuses what the policy forbids', () => {
	it('answers one workspace ledger to that workspace alone', async () => {
		await attest('tenant-a', 'A first', 10);
		await attest('tenant-b', 'B first', 20);

		const mine = await shared.repository.list('tenant-a', {
			limit: 10,
			after: null,
		});

		expect(mine.map((row) => row.note)).toEqual(['A first']);
	});

	it('rejects a row that carries another workspace identifier', async () => {
		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO access_attestations (id, tenant_id,
						 reviewer_account_id, reviewer_label, period_from, period_to,
						 member_count, active_member_count, role_count, extra_scope_count,
						 token_count, provider_count, note, created_at)
						 VALUES ('smuggled', 'tenant-b', 'account-1', 'a@example.com',
						 '2026-06-01T00:00:00.000Z', '2026-06-30T00:00:00.000Z',
						 0, 0, 0, 0, 0, 0, NULL, 1)`,
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			),
		).rejects.toThrow(/row-level security policy/);

		const rows = await shared.repository.list('tenant-b', {
			limit: 10,
			after: null,
		});
		expect(rows).toEqual([]);
	});
});

describe('the attestations data class', () => {
	it('is kept, exportable and carries no erasure', () => {
		const [declaration] = accessDataClasses(async () => service());

		expect(declaration).toMatchObject({
			key: 'attestations',
			defaultRetentionDays: null,
			exportable: true,
		});
		expect(declaration?.sweep).toBeUndefined();
		expect(declaration?.erase).toBeUndefined();
	});

	it('exports one workspace ledger oldest first and nobody else', async () => {
		await attest('tenant-a', 'A first', 10);
		await attest('tenant-a', 'A second', 20);
		await attest('tenant-b', 'B first', 30);
		const rows: Record<string, unknown>[] = [];
		const [declaration] = accessDataClasses(async () => service());

		const summary = await declaration!.export!({
			tenantId: 'tenant-a',
			sink: {
				write: async (row) => {
					rows.push(row);
				},
			},
		});

		expect(rows.map((row) => row.note)).toEqual(['A first', 'A second']);
		expect(summary).toEqual({
			rows: 2,
			from: new Date(10),
			to: new Date(20),
		});
		expect(rows[0]).not.toHaveProperty('tenantId');
	});
});
