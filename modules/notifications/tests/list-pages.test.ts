import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PageDirection } from '../src/services/repository.ts';
import {
	openNotificationsTestDatabase,
	type NotificationsTestDatabase,
} from './support/database.ts';
import { createHarness, publicResolver } from './support/harness.ts';

const TENANT = 'tenant-pages';
const RESOLVER = publicResolver({ 'hooks.example': '93.184.216.34' });
const NAMES = ['beta', 'Alpha', 'gamma', 'Delta', 'epsilon', 'Zeta', 'eta'];

let shared: NotificationsTestDatabase;

beforeAll(async () => {
	shared = await openNotificationsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

function harness(now = 1_000) {
	let clock = now;
	return createHarness({
		repository: shared.repository,
		resolve: RESOLVER,
		/* Two rows per millisecond, so every page boundary meets the id tiebreak. */
		now: () => {
			clock += 1;
			return Math.floor(clock / 2) * 2;
		},
	});
}

async function seed() {
	const { webhooks, publisher } = harness();
	for (const name of NAMES) {
		await webhooks.create(TENANT, 'account-owner', {
			name,
			url: `https://hooks.example/${name.toLowerCase()}`,
			events: ['agent-run-failed'],
		});
	}
	for (let index = 0; index < NAMES.length; index += 1) {
		await publisher.publish({
			tenantId: TENANT,
			kind: 'agent-run-failed',
			sourceModule: 'agents.core',
			sourceRef: `run-${index}`,
			title: `Run ${index}`,
			recipients: ['account-ada'],
		});
	}
}

/* Walks one list in pages of `size` and returns the ids in the order met. */
async function walk<Key extends string | number>(
	read: (
		after: { readonly key: Key; readonly id: string } | null,
		limit: number,
	) => Promise<{
		readonly items: readonly { readonly id: string }[];
		readonly next: { readonly key: Key; readonly id: string } | null;
	}>,
	size: number,
): Promise<readonly string[]> {
	const ids: string[] = [];
	let after: { readonly key: Key; readonly id: string } | null = null;
	let pages = 0;
	do {
		const page = await read(after, size);
		expect(page.next === null).toBe(page.items.length < size);
		ids.push(...page.items.map((item) => item.id));
		after = page.next;
		pages += 1;
	} while (after !== null);
	expect(pages).toBe(
		Math.ceil(NAMES.length / size) + (NAMES.length % size === 0 ? 1 : 0),
	);
	return ids;
}

describe('notifications list pages', () => {
	for (const direction of [
		'asc',
		'desc',
	] as const satisfies readonly PageDirection[]) {
		it(`walks the inbox ${direction} in pages that match the whole order`, async () => {
			await seed();
			const { inbox } = harness();
			const whole = await inbox.list(
				TENANT,
				'account-ada',
				{},
				{
					limit: 200,
					direction,
				},
			);
			expect(whole).toHaveLength(NAMES.length);
			expect(
				await walk<number>(
					(after, limit) =>
						inbox.listPage(
							TENANT,
							'account-ada',
							{},
							{ limit, direction, after },
						),
					3,
				),
			).toEqual(whole.map((item) => item.id));
		});

		it(`walks the subscriptions ${direction} by normalized name in pages that match the whole order`, async () => {
			await seed();
			const { webhooks } = harness();
			const whole = await webhooks.list(TENANT, {}, { limit: 200, direction });
			const expected = [...NAMES].sort((left, right) =>
				left.toLowerCase() < right.toLowerCase() ? -1 : 1,
			);
			expect(whole.map((entry) => entry.name)).toEqual(
				direction === 'asc' ? expected : expected.reverse(),
			);
			expect(
				await walk<string>(
					(after, limit) =>
						webhooks.listPage(TENANT, {}, { limit, direction, after }),
					2,
				),
			).toEqual(whole.map((entry) => entry.id));
		});

		it(`walks the ledger ${direction} in pages that match the whole order`, async () => {
			await seed();
			const { deliveries } = harness();
			const whole = await deliveries.list(
				TENANT,
				{},
				{ limit: 200, direction },
			);
			expect(whole).toHaveLength(NAMES.length * NAMES.length);
			const ids: string[] = [];
			let after: { readonly key: number; readonly id: string } | null = null;
			do {
				const page = await deliveries.listPage(
					TENANT,
					{},
					{
						limit: 10,
						direction,
						after,
					},
				);
				ids.push(...page.items.map((item) => item.id));
				after = page.next;
			} while (after !== null);
			expect(ids).toEqual(whole.map((entry) => entry.id));
		});
	}

	it('keys a subscription page by the name as the database normalizes it', async () => {
		await seed();
		const { webhooks } = harness();
		const first = await webhooks.listPage(TENANT, {}, { limit: 2 });
		expect(first.items.map((entry) => entry.name)).toEqual(['Alpha', 'beta']);
		expect(first.next).toMatchObject({ key: 'beta', id: first.items[1]!.id });
		const second = await webhooks.listPage(
			TENANT,
			{},
			{
				limit: 2,
				after: first.next,
			},
		);
		expect(second.items.map((entry) => entry.name)).toEqual([
			'Delta',
			'epsilon',
		]);
	});

	it('refuses a page bound, direction or key it cannot serve', async () => {
		const { inbox, webhooks } = harness();
		await expect(
			inbox.list(TENANT, 'account-ada', {}, { limit: 201 }),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		await expect(
			inbox.list(TENANT, 'account-ada', {}, { limit: 0 }),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		await expect(
			inbox.list(
				TENANT,
				'account-ada',
				{},
				{
					direction: 'sideways' as never,
				},
			),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		await expect(
			inbox.list(
				TENANT,
				'account-ada',
				{},
				{
					after: { key: 'yesterday' as never, id: 'x' },
				},
			),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		await expect(
			webhooks.list(TENANT, {}, { after: { key: 7 as never, id: 'x' } }),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
	});
});
