import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorCall } from '../src/domain/types.ts';
import type { ConnectorListDirection } from '../src/services/repository.ts';
import {
	openConnectorsTestDatabase,
	type ConnectorsTestDatabase,
} from './support/database.ts';
import { seedInstance, testVault } from './support/harness.ts';

const TENANT = 'tenant-paging';
const NAMES = [
	'delta',
	'Alpha',
	'charlie',
	'Bravo',
	'echo',
	'alpine',
	'Delta2',
];

let shared: ConnectorsTestDatabase;

beforeAll(async () => {
	shared = await openConnectorsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

async function seed() {
	const vault = testVault();
	const seeded = [];
	for (const name of NAMES) {
		seeded.push(
			await seedInstance(shared.repository, vault, {
				tenantId: TENANT,
				baseUrl: 'https://api.example.test/v1',
				name,
			}),
		);
	}
	return seeded;
}

function call(index: number, instanceId: string): ConnectorCall {
	return {
		id: `call-${String(index).padStart(3, '0')}`,
		tenantId: TENANT,
		instanceId,
		operation: 'get',
		caller: 'test',
		callerRef: null,
		outcome: 'succeeded',
		status: 200,
		errorClass: null,
		durationMs: 1,
		requestBytes: 0,
		responseBytes: 0,
		occurredAt: 1_000 + Math.floor(index / 3),
	};
}

describe('connectors paged reads', () => {
	for (const direction of ['asc', 'desc'] as const) {
		it(`walks instances by normalized name ${direction} exactly as one read orders them`, async () => {
			await seed();
			const whole = await shared.repository.listInstances(
				TENANT,
				{},
				{ direction, after: null, limit: 200 },
			);
			const expected = [...NAMES].sort((left, right) =>
				left.toLowerCase() < right.toLowerCase() ? -1 : 1,
			);
			if (direction === 'desc') expected.reverse();
			expect(whole.map((row) => row.name)).toEqual(expected);

			const walked: string[] = [];
			let after: { name: string; id: string } | null = null;
			for (let pages = 0; pages < 10; pages += 1) {
				const page = await shared.repository.listInstances(
					TENANT,
					{},
					{ direction, after, limit: 2 },
				);
				walked.push(...page.map((row) => row.id));
				const last = page.at(-1);
				if (!last || page.length < 2) break;
				after = { name: last.name.toLowerCase(), id: last.id };
			}
			expect(walked).toEqual(whole.map((row) => row.id));
		});
	}

	it('walks calls by time and id in both directions without overlap or gap', async () => {
		const [instance] = await seed();
		for (let index = 0; index < 8; index += 1) {
			await shared.repository.recordCall(call(index, instance!.id), null);
		}
		for (const direction of ['desc', 'asc'] as ConnectorListDirection[]) {
			const whole = await shared.repository.listCalls(
				TENANT,
				{},
				{ direction, after: null, limit: 200 },
			);
			expect(whole).toHaveLength(8);
			expect(whole[0]).toMatchObject({ instanceName: NAMES[0] });
			const walked: string[] = [];
			let after: { occurredAt: number; id: string } | null = null;
			for (let pages = 0; pages < 10; pages += 1) {
				const page = await shared.repository.listCalls(
					TENANT,
					{},
					{ direction, after, limit: 3 },
				);
				walked.push(...page.map((row) => row.id));
				const last = page.at(-1);
				if (!last || page.length < 3) break;
				after = { occurredAt: last.occurredAt, id: last.id };
			}
			expect([direction, walked]).toEqual([
				direction,
				whole.map((row) => row.id),
			]);
		}
	});

	it('matches a search term as text, not as a pattern', async () => {
		await seed();
		const percent = await shared.repository.listInstances(
			TENANT,
			{ search: '%' },
			{ direction: 'asc', after: null, limit: 200 },
		);
		expect(percent).toEqual([]);
		const term = await shared.repository.listInstances(
			TENANT,
			{ search: 'ALP' },
			{ direction: 'asc', after: null, limit: 200 },
		);
		expect(term.map((row) => row.name)).toEqual(['Alpha', 'alpine']);
	});
});
