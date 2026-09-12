import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '@flowdular/database';
import { DatabaseMeteringRepository } from '../src/services/database-repository.ts';
import {
	openMeteringTestDatabase,
	type MeteringTestDatabase,
} from './support/database.ts';
import {
	clock,
	createHarness,
	recordingPublisher,
	RUN_TOKENS_KEY,
} from './support/harness.ts';

const TENANT = 'tenant-concurrent';
const SEPTEMBER_1 = Date.UTC(2026, 8, 1, 9, 0, 0);
const SEPTEMBER_2 = Date.UTC(2026, 8, 2, 9, 0, 0);

let shared: MeteringTestDatabase;

beforeAll(async () => {
	shared = await openMeteringTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

async function seedLimit(monthlyLimit: number): Promise<void> {
	await createHarness({
		repository: shared.repository,
		now: () => SEPTEMBER_1,
	}).service.setLimit({
		tenantId: TENANT,
		meter: RUN_TOKENS_KEY,
		monthlyLimit,
		setBy: 'cli:test',
	});
}

/**
 * A handle that answers plausibly and keeps every statement. The embedded
 * engine runs one connection and serialises transactions
 * (`packages/database-pglite/src/driver.ts`), so it cannot show two facts
 * racing: what a test can prove here is that the fact's own read of the limit
 * is the locking one, which is what makes the later fact sum after the earlier
 * committed on a real server.
 */
function recordingHandle(): {
	readonly handle: DatabaseHandle;
	readonly statements: string[];
} {
	const statements: string[] = [];
	const answer = (text: string) => {
		statements.push(text);
		if (text.includes('monthly_limit FROM metering_limits')) {
			return [{ monthly_limit: 100 }];
		}
		return text.includes('SUM(amount)') ? [{ used: 40 }] : [];
	};
	const transaction = {
		query: async ({ text }: { text: string }) => {
			const rows = answer(text);
			return { rows, rowCount: rows.length };
		},
		execute: async ({ text }: { text: string }) => {
			statements.push(text);
			return { affectedRows: 1 };
		},
	};
	const handle = {
		transaction: (run: (session: unknown) => unknown) =>
			Promise.resolve(run(transaction)),
	} as unknown as DatabaseHandle;
	return { handle, statements };
}

const FACT = {
	tenantId: TENANT,
	meter: {
		key: RUN_TOKENS_KEY,
		moduleId: 'agents.core',
		label: 'Agent run tokens',
		unit: 'tokens',
		kind: 'cumulative' as const,
	},
	day: '2026-09-01',
	month: '2026-09',
	amount: 10,
	sourceRef: null,
	at: SEPTEMBER_1,
};

describe('METERING-THRESHOLDS under concurrent facts', () => {
	it('reads the limit of a fact under a row lock, and a plain read without one', async () => {
		const writing = recordingHandle();
		await new DatabaseMeteringRepository(writing.handle).recordFact(FACT);
		const reading = recordingHandle();
		await new DatabaseMeteringRepository(reading.handle).usageAgainstLimit(
			TENANT,
			RUN_TOKENS_KEY,
			'2026-09',
		);

		expect(
			writing.statements.find((text) => text.includes('FROM metering_limits')),
		).toMatch(/FOR UPDATE/);
		expect(
			reading.statements.find((text) => text.includes('FROM metering_limits')),
		).not.toMatch(/FOR UPDATE/);
	});

	/* Two facts of the same month on different days touch different bucket
	   rows, so nothing but the limit row makes them queue. */
	it('publishes the crossing once when two facts of one month arrive together', async () => {
		await seedLimit(100);
		const publisher = recordingPublisher();
		const { service } = createHarness({
			repository: shared.repository,
			now: clock(SEPTEMBER_1).now,
			publisher,
			owners: ['account-ada'],
		});

		await Promise.all([
			service.record({
				tenantId: TENANT,
				meter: RUN_TOKENS_KEY,
				amount: 50,
				at: SEPTEMBER_1,
				sourceRef: 'run-a',
			}),
			service.record({
				tenantId: TENANT,
				meter: RUN_TOKENS_KEY,
				amount: 50,
				at: SEPTEMBER_2,
				sourceRef: 'run-b',
			}),
		]);

		expect(publisher.published.map((event) => event.sourceRef)).toEqual([
			`${RUN_TOKENS_KEY}:2026-09:warning`,
			`${RUN_TOKENS_KEY}:2026-09:exhausted`,
		]);
	});
});

describe('METERING-DECLARE-RECORD under concurrent facts', () => {
	it('counts one source reference once when both calls arrive together', async () => {
		const { service } = createHarness({
			repository: shared.repository,
			now: clock(SEPTEMBER_1).now,
		});
		const fact = {
			tenantId: TENANT,
			meter: RUN_TOKENS_KEY,
			amount: 40,
			sourceRef: 'run-once',
		};

		const outcomes = await Promise.all([
			service.record(fact),
			service.record(fact),
		]);

		expect(outcomes.map((outcome) => outcome.recorded).sort()).toEqual([
			false,
			true,
		]);
		expect(
			(await service.buckets(TENANT, { meter: RUN_TOKENS_KEY })).map(
				(bucket) => [bucket.amount, bucket.events],
			),
		).toEqual([[40, 1]]);
	});
});
