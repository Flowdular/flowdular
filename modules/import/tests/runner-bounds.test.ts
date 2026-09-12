import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobEvent } from '@flowdular/server';
import {
	IMPORT_LIMITS,
	type ClaimedImportJob,
	type ImportJobRouting,
} from '../src/domain/types.ts';
import {
	createImportJobRunner,
	IMPORT_POLL_INTERVAL_MS,
} from '../src/services/import-runner.ts';
import type { ImportService } from '../src/services/import-service.ts';
import type { ImportRepository } from '../src/services/repository.ts';

/**
 * The claim and the routing read alone: these cases are about how often the
 * runner asks the queue, not about what a stage does with a job, so the
 * repository behind them is a stub and no database is opened.
 */
interface Source {
	readonly page: (limit: number) => Promise<readonly ImportJobRouting[]>;
	readonly claim: (id: string) => Promise<ClaimedImportJob | null>;
}

const START = 1_700_000_000_000;
let clock = START;
let reads = 0;
let claims = 0;
let events: JobEvent[] = [];

function routing(id: string): ImportJobRouting {
	return { tenantId: 'tenant-bounds', id, status: 'parsing', startedAt: START };
}

/** A page every row of which another process is holding. */
function heldPage(limit: number): readonly ImportJobRouting[] {
	return Array.from({ length: limit }, (_, index) => routing(`job-${index}`));
}

function runner(source: Source) {
	const repository = {
		listPendingJobs: async (limit: number) => {
			reads += 1;
			return source.page(limit);
		},
		claimJob: async (input: { readonly id: string }) => {
			claims += 1;
			return source.claim(input.id);
		},
		heartbeatJob: async () => true,
	} as unknown as ImportRepository;
	const service = {
		perform: async () => undefined,
	} as unknown as ImportService;
	return createImportJobRunner({
		repository: async () => repository,
		service: async () => service,
		now: () => Date.now(),
		onEvent: (event) => {
			events.push(event);
		},
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
	clock = START;
	reads = 0;
	claims = 0;
	events = [];
});

afterEach(() => {
	vi.useRealTimers();
});

describe('the routing read bound', () => {
	it('walks one page of rows it cannot take, however deep the queue is', async () => {
		/* Every page is full, and only its last row can be taken. One claim per
		   page empties the queue, so an unbounded walk reads the routing table
		   again for every job the pass is allowed to claim. */
		const last = `job-${IMPORT_LIMITS.routingPage - 1}`;
		const job = runner({
			page: async (limit) => heldPage(limit),
			claim: async (id) =>
				id === last ? ({ id, claimedAt: clock } as ClaimedImportJob) : null,
		});

		/* The pass still makes progress; what it may not do is pay for it with a
		   routing read per row. */
		expect((await job.tick()).performed).toBeGreaterThanOrEqual(1);
		/* The page it filled plus at most one refill, as the loop documents. */
		expect(reads).toBeLessThanOrEqual(2);
		/* And one claim statement per row walked, over two pages at the most. */
		expect(claims).toBeLessThanOrEqual(IMPORT_LIMITS.routingPage * 2);
	});

	it('keeps claiming across passes when the page is full of work', async () => {
		/* A saturated queue: every row can be taken, so the bound on rows walked
		   past must not cost the next pass its claims. */
		const job = runner({
			page: async (limit) => heldPage(limit),
			claim: async (id) => ({ id, claimedAt: clock }) as ClaimedImportJob,
		});

		expect((await job.tick()).performed).toBe(IMPORT_LIMITS.routingPage);
		expect((await job.tick()).performed).toBe(IMPORT_LIMITS.routingPage);
	});
});

describe('the backoff on a raising claim', () => {
	it('doubles the wait between passes and returns to the interval once it stops raising', async () => {
		let raising = true;
		const job = runner({
			page: async () => {
				if (raising) throw new Error('connection reset');
				return [];
			},
			claim: async () => null,
		});

		job.start();
		await vi.advanceTimersByTimeAsync(IMPORT_POLL_INTERVAL_MS * 16);
		const failedAt = (): readonly number[] =>
			events
				.filter((event) => event.type === 'claim-failed')
				.map((event) => event.at - START);

		/* Each wait is the one before it doubled: a loop that kept its interval
		   would have asked a refusing database eight times by here. */
		expect(failedAt().slice(0, 4)).toEqual([
			0,
			IMPORT_POLL_INTERVAL_MS,
			IMPORT_POLL_INTERVAL_MS * 3,
			IMPORT_POLL_INTERVAL_MS * 7,
		]);

		raising = false;
		await vi.advanceTimersByTimeAsync(IMPORT_POLL_INTERVAL_MS * 16);
		const recovered = reads;
		await vi.advanceTimersByTimeAsync(IMPORT_POLL_INTERVAL_MS * 4);
		/* A pass that stopped raising is back on the interval, not the ceiling. */
		expect(reads - recovered).toBe(4);

		await job.quiesce();
	});
});
