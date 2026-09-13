import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
	ApprovalListDirection,
	ApprovalRequest,
} from '../src/domain/types.ts';
import type { ApprovalRequestFilters } from '../src/services/repository.ts';
import {
	openApprovalsTestDatabase,
	type ApprovalsTestDatabase,
} from './support/database.ts';

const TENANT = 'tenant-paging';
const DECIDER = 'account-decider';

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

function request(
	index: number,
	createdAt: number,
	status: ApprovalRequest['status'] = 'pending',
): ApprovalRequest {
	return {
		id: `request-${String(index).padStart(2, '0')}`,
		tenantId: TENANT,
		subjectModule: 'catalog.core',
		subjectRef: `product-${index}`,
		permission: 'catalog.products.manage',
		action: 'publish',
		title: `Publish product ${index}`,
		summary: null,
		requesterAccountId: 'account-requester',
		requirement: {
			roleKey: 'owner',
			scope: null,
			decisions: 1,
			expiresInDays: 7,
		},
		decisionsNeeded: 1,
		status,
		expiresAt: createdAt + 1_000,
		resolvedAt: status === 'pending' ? null : createdAt + 10,
		createdAt,
	};
}

/* Ties on created_at are what the id tie-break exists for, so several rows
   share a timestamp; the deciders alternate so the EXISTS filter narrows too. */
async function seed(): Promise<void> {
	const stamps = [
		1_000, 2_000, 2_000, 2_000, 3_000, 3_000, 4_000, 5_000, 5_000,
	];
	for (const [index, createdAt] of stamps.entries()) {
		await shared.repository.create(
			request(index, createdAt, index % 3 === 0 ? 'approved' : 'pending'),
			index % 2 === 0 ? [DECIDER] : ['account-other'],
		);
	}
}

async function walk(
	filters: ApprovalRequestFilters,
	direction: ApprovalListDirection,
	limit: number,
): Promise<readonly string[]> {
	const ids: string[] = [];
	let after: { createdAt: number; id: string } | null = null;
	for (let pages = 0; pages < 20; pages += 1) {
		const page = await shared.repository.listPage(TENANT, filters, {
			limit,
			sort: 'createdAt',
			direction,
			after,
		});
		ids.push(...page.map((entry) => entry.id));
		if (page.length < limit) break;
		const last = page.at(-1)!;
		after = { createdAt: last.createdAt, id: last.id };
	}
	return ids;
}

describe('APPROVALS-INBOX-PAGE repository', () => {
	it('APPROVALS-INBOX-PAGE pages in the order the bounded read answers, under every filter', async () => {
		await seed();
		for (const filters of [
			{},
			{ status: 'pending' },
			{ decidableBy: DECIDER },
			{ status: 'pending', decidableBy: DECIDER },
		] as const) {
			const whole = (await shared.repository.list(TENANT, filters, 200)).map(
				(entry) => entry.id,
			);
			expect(whole.length).toBeGreaterThan(2);
			expect(new Set(whole).size).toBe(whole.length);
			for (const limit of [1, 2, 4]) {
				expect([filters, limit, await walk(filters, 'desc', limit)]).toEqual([
					filters,
					limit,
					whole,
				]);
				expect([filters, limit, await walk(filters, 'asc', limit)]).toEqual([
					filters,
					limit,
					[...whole].reverse(),
				]);
			}
		}
	});

	it('APPROVALS-INBOX-PAGE orders ties on createdAt by id in the same direction', async () => {
		await seed();
		const descending = await shared.repository.list(TENANT, {}, 200);
		for (let index = 1; index < descending.length; index += 1) {
			const previous = descending[index - 1]!;
			const current = descending[index]!;
			expect(
				previous.createdAt > current.createdAt ||
					(previous.createdAt === current.createdAt &&
						previous.id > current.id),
			).toBe(true);
		}
	});
});
