import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createJobRunner,
	JOB_CLAIM_LOST,
	JobClaimLostError,
	type JobEvent,
	type JobPassReport,
} from '../src/jobs/index.ts';
import type { Logger } from '../src/log.ts';

interface Item {
	readonly id: string;
}

const BASE = {
	name: 'test.job',
	intervalMs: 1_000,
	staleAfterMs: 300,
} as const;

const IDLE: JobPassReport = {
	claimed: 0,
	performed: 0,
	failed: 0,
	claimLost: 0,
};

/** The instant every runner in this file reads. No case depends on wall time. */
let clock = 1_700_000_000_000;
let events: JobEvent[] = [];
let logged: { message: string; err: unknown }[] = [];

const now = (): number => clock;

const logger = (): Logger => ({
	level: 'error',
	format: 'text',
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: (message, event) => {
		logged.push({ message, err: event?.err });
	},
});

const record = (event: JobEvent): void => {
	events.push(event);
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** A queue of items a claim hands out once, then answers null forever. */
function queueOf(...ids: readonly string[]): () => Promise<Item | null> {
	const queue = ids.map((id) => ({ id }));
	return async () => queue.shift() ?? null;
}

function delaysOf(): readonly number[] {
	const delays: number[] = [];
	for (const event of events) {
		if (event.type === 'pass-end') delays.push(event.nextDelayMs);
	}
	return delays;
}

function passCount(): number {
	return events.filter((event) => event.type === 'pass-start').length;
}

beforeEach(() => {
	vi.useFakeTimers();
	clock = 1_700_000_000_000;
	events = [];
	logged = [];
});

afterEach(() => {
	vi.useRealTimers();
});

describe('the pass', () => {
	it('never runs two passes at once', async () => {
		const gate = deferred();
		let live = 0;
		let peak = 0;
		let claims = 0;
		const claim = queueOf('a', 'b');
		const runner = createJobRunner<Item>({
			...BASE,
			logger,
			now,
			onEvent: record,
			claim: async () => {
				claims += 1;
				return claim();
			},
			perform: async () => {
				live += 1;
				peak = Math.max(peak, live);
				await gate.promise;
				live -= 1;
			},
		});

		const first = runner.tick();
		const second = runner.tick();
		await vi.advanceTimersByTimeAsync(0);
		gate.resolve();
		const [one, two] = await Promise.all([first, second]);

		expect(peak).toBe(1);
		expect(one).toEqual({ claimed: 2, performed: 2, failed: 0, claimLost: 0 });
		expect(two).toEqual(one);
		/* Two items and the null that ends the pass: the second call joined the
		   pass in flight rather than claiming anything of its own. */
		expect(claims).toBe(3);
		expect(passCount()).toBe(1);
	});

	it('takes at most the batch limit of claims per pass', async () => {
		let claims = 0;
		const runner = createJobRunner<Item>({
			...BASE,
			batchLimit: 3,
			logger,
			now,
			onEvent: record,
			/* Deep enough that an unbounded pass drains it instead of hanging. */
			claim: async () => (claims++ < 100 ? { id: `item-${claims}` } : null),
			perform: async () => undefined,
		});

		expect(await runner.tick()).toEqual({
			claimed: 3,
			performed: 3,
			failed: 0,
			claimLost: 0,
		});
		expect(claims).toBe(3);
		/* The next pass continues where this one stopped; nothing is dropped. */
		expect((await runner.tick()).claimed).toBe(3);
		expect(claims).toBe(6);
	});

	it('keeps the pass going when one item fails', async () => {
		const performed: string[] = [];
		const runner = createJobRunner<Item>({
			...BASE,
			logger,
			now,
			onEvent: record,
			claim: queueOf('a', 'b', 'c'),
			perform: async (item) => {
				if (item.id === 'b') throw new Error('port refused');
				performed.push(item.id);
			},
		});

		expect(await runner.tick()).toEqual({
			claimed: 3,
			performed: 2,
			failed: 1,
			claimLost: 0,
		});
		expect(performed).toEqual(['a', 'c']);
		expect(logged).toHaveLength(1);
		expect(logged[0]?.message).toBe('test.job work failed');
		expect(events.filter((event) => event.type === 'item-failed')).toHaveLength(
			1,
		);
	});

	it('ends the pass when the claim itself raises, keeping what it performed', async () => {
		const performed: string[] = [];
		let claims = 0;
		const runner = createJobRunner<Item>({
			...BASE,
			logger,
			now,
			onEvent: record,
			claim: async () => {
				claims += 1;
				if (claims === 2) throw new Error('connection reset');
				return { id: `item-${claims}` };
			},
			perform: async (item) => {
				performed.push(item.id);
			},
		});

		expect(await runner.tick()).toEqual({
			claimed: 1,
			performed: 1,
			failed: 0,
			claimLost: 0,
		});
		expect(performed).toEqual(['item-1']);
		expect(claims).toBe(2);
		expect(logged[0]?.message).toBe('test.job claim failed');
	});

	it('performs a pass on demand without the loop running', async () => {
		const performed: string[] = [];
		const runner = createJobRunner<Item>({
			...BASE,
			logger,
			now,
			onEvent: record,
			claim: queueOf('a'),
			perform: async (item) => {
				performed.push(item.id);
			},
		});

		expect((await runner.tick()).performed).toBe(1);
		expect(performed).toEqual(['a']);
		/* A tick from outside is one pass, not a start: nothing is scheduled. */
		await vi.advanceTimersByTimeAsync(60_000);
		expect(passCount()).toBe(1);
	});
});

describe('the concurrency bound', () => {
	/** Holds every item until it is released, reporting how many wait at once. */
	function gatedPerform(): {
		readonly perform: (item: Item) => Promise<void>;
		readonly waiting: () => readonly string[];
		readonly peak: () => number;
		release(id: string): void;
	} {
		const gates = new Map<string, () => void>();
		const order: string[] = [];
		let live = 0;
		let peak = 0;
		return {
			perform: async (item) => {
				live += 1;
				peak = Math.max(peak, live);
				order.push(item.id);
				await new Promise<void>((resolve) => gates.set(item.id, resolve));
				live -= 1;
			},
			waiting: () => [...gates.keys()],
			peak: () => peak,
			release(id) {
				gates.get(id)?.();
				gates.delete(id);
			},
		};
	}

	it('performs no more than the concurrency however deep the batch is', async () => {
		const gated = gatedPerform();
		let claims = 0;
		const runner = createJobRunner<Item>({
			...BASE,
			batchLimit: 9,
			concurrency: 3,
			logger,
			now,
			onEvent: record,
			claim: async () => (claims++ < 9 ? { id: `item-${claims}` } : null),
			perform: gated.perform,
		});

		const pass = runner.tick();
		await vi.advanceTimersByTimeAsync(0);
		/* Three performing, and the claim that would take a fourth is not made
		   until one of them is done: the bound covers the source too. */
		expect(gated.waiting()).toEqual(['item-1', 'item-2', 'item-3']);
		expect(claims).toBe(3);

		gated.release('item-2');
		await vi.advanceTimersByTimeAsync(0);
		expect(gated.waiting()).toEqual(['item-1', 'item-3', 'item-4']);

		for (let step = 0; step < 9; step += 1) {
			for (const id of gated.waiting()) gated.release(id);
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(await pass).toEqual({
			claimed: 9,
			performed: 9,
			failed: 0,
			claimLost: 0,
		});
		expect(gated.peak()).toBe(3);
	});

	it('claims one item at a time however many workers are asking', async () => {
		let inClaim = 0;
		let overlapped = false;
		let claims = 0;
		const runner = createJobRunner<Item>({
			...BASE,
			batchLimit: 8,
			concurrency: 4,
			logger,
			now,
			onEvent: record,
			claim: async () => {
				inClaim += 1;
				if (inClaim > 1) overlapped = true;
				await Promise.resolve();
				inClaim -= 1;
				return claims++ < 8 ? { id: `item-${claims}` } : null;
			},
			perform: async () => undefined,
		});

		expect((await runner.tick()).performed).toBe(8);
		expect(overlapped).toBe(false);
	});

	it('isolates a failing item from the ones running beside it', async () => {
		const performed: string[] = [];
		const runner = createJobRunner<Item>({
			...BASE,
			concurrency: 4,
			logger,
			now,
			onEvent: record,
			claim: queueOf('a', 'b', 'c', 'd'),
			perform: async (item) => {
				if (item.id === 'b') throw new Error('port refused');
				/* Long enough that the failure lands while these are still running. */
				await vi.advanceTimersByTimeAsync(5);
				performed.push(item.id);
			},
		});

		expect(await runner.tick()).toEqual({
			claimed: 4,
			performed: 3,
			failed: 1,
			claimLost: 0,
		});
		expect([...performed].sort()).toEqual(['a', 'c', 'd']);
		expect(logged).toHaveLength(1);
	});

	it('gives each item performed at once its own fence and its own abort', async () => {
		const aborted: string[] = [];
		const lost = new Set(['b']);
		const runner = createJobRunner<Item>({
			...BASE,
			concurrency: 3,
			heartbeatEveryMs: 10,
			heartbeat: async (item) => !lost.has(item.id),
			logger,
			now,
			onEvent: record,
			claim: queueOf('a', 'b', 'c'),
			perform: async (item, signal) => {
				await vi.advanceTimersByTimeAsync(30);
				if (signal.aborted) {
					aborted.push(item.id);
					throw signal.reason;
				}
			},
		});

		expect(await runner.tick()).toEqual({
			claimed: 3,
			performed: 2,
			failed: 0,
			claimLost: 1,
		});
		/* Only the item whose fence answered false saw an abort. */
		expect(aborted).toEqual(['b']);
		expect(logged).toEqual([]);
	});

	it('quiesce waits for every item in flight, not just the first', async () => {
		const gated = gatedPerform();
		const finished: string[] = [];
		const runner = createJobRunner<Item>({
			...BASE,
			concurrency: 3,
			logger,
			now,
			onEvent: record,
			claim: queueOf('a', 'b', 'c'),
			perform: async (item) => {
				await gated.perform(item);
				finished.push(item.id);
			},
		});

		runner.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(gated.waiting()).toEqual(['a', 'b', 'c']);

		let drained = false;
		const quiesced = runner.quiesce().then(() => {
			drained = true;
		});
		gated.release('a');
		await vi.advanceTimersByTimeAsync(0);
		expect(drained).toBe(false);
		expect(finished).toEqual(['a']);

		gated.release('b');
		gated.release('c');
		await quiesced;
		expect([...finished].sort()).toEqual(['a', 'b', 'c']);

		/* The loop is stopped with the pass it drained. */
		await vi.advanceTimersByTimeAsync(60_000);
		expect(passCount()).toBe(1);
	});

	it('falls back to one worker when the setting is not a bound it can hold', async () => {
		const peaks: number[] = [];
		for (const concurrency of [0, -4, 1.5, Number.NaN]) {
			let live = 0;
			let peak = 0;
			const runner = createJobRunner<Item>({
				...BASE,
				concurrency,
				logger,
				now,
				claim: queueOf('a', 'b', 'c'),
				perform: async () => {
					live += 1;
					peak = Math.max(peak, live);
					await vi.advanceTimersByTimeAsync(1);
					live -= 1;
				},
			});
			expect([concurrency, (await runner.tick()).performed]).toEqual([
				concurrency,
				3,
			]);
			peaks.push(peak);
		}
		expect(peaks).toEqual([1, 1, 1, 1]);
	});

	it('caps a pool asked for more than the ceiling', async () => {
		let live = 0;
		let peak = 0;
		let claims = 0;
		const runner = createJobRunner<Item>({
			...BASE,
			batchLimit: 200,
			concurrency: 1_000,
			logger,
			now,
			claim: async () => (claims++ < 200 ? { id: `item-${claims}` } : null),
			perform: async () => {
				live += 1;
				peak = Math.max(peak, live);
				await vi.advanceTimersByTimeAsync(1);
				live -= 1;
			},
		});

		expect((await runner.tick()).performed).toBe(200);
		expect(peak).toBe(64);
	});
});

describe('the claim fence', () => {
	it('aborts the work with a stable CLAIM_LOST when the fence answers false', async () => {
		let held = true;
		let reason: unknown;
		const runner = createJobRunner<Item>({
			...BASE,
			heartbeatEveryMs: 10,
			heartbeat: async () => held,
			logger,
			now,
			onEvent: record,
			claim: queueOf('a'),
			perform: async (_item, signal) => {
				/* Another process reclaimed the row while this stage was running. A
				   stage that observes the abort stops by raising, so nothing it did
				   is settled under a claim it no longer holds. */
				held = false;
				await new Promise<void>((resolve) => {
					signal.addEventListener('abort', () => resolve());
				});
				reason = signal.reason;
				throw signal.reason;
			},
		});

		const pass = runner.tick();
		await vi.advanceTimersByTimeAsync(10);
		expect(await pass).toEqual({
			claimed: 1,
			performed: 0,
			failed: 0,
			claimLost: 1,
		});
		expect(reason).toBeInstanceOf(JobClaimLostError);
		expect((reason as JobClaimLostError).code).toBe(JOB_CLAIM_LOST);
		/* A claim another process took is contention, not the job's failure. */
		expect(logged).toEqual([]);
		expect(events.some((event) => event.type === 'claim-lost')).toBe(true);
	});

	it('renews the claim on its own timer while the work runs', async () => {
		const renewals: number[] = [];
		const runner = createJobRunner<Item>({
			...BASE,
			heartbeatEveryMs: 10,
			heartbeat: async (_item, at) => {
				renewals.push(at);
				return true;
			},
			logger,
			now,
			onEvent: record,
			claim: queueOf('a'),
			perform: async () => {
				for (let step = 0; step < 3; step += 1) {
					clock += 10;
					await vi.advanceTimersByTimeAsync(10);
				}
			},
		});

		expect((await runner.tick()).performed).toBe(1);
		expect(renewals).toEqual([
			1_700_000_000_010, 1_700_000_000_020, 1_700_000_000_030,
		]);
		/* The timer is gone with the work it was renewing. */
		await vi.advanceTimersByTimeAsync(100);
		expect(renewals).toHaveLength(3);
	});

	it('keeps the claim when the fence cannot be answered at all', async () => {
		let beats = 0;
		let aborted = false;
		const runner = createJobRunner<Item>({
			...BASE,
			heartbeatEveryMs: 10,
			heartbeat: async () => {
				beats += 1;
				throw new Error('connection reset');
			},
			logger,
			now,
			onEvent: record,
			claim: queueOf('a'),
			perform: async (_item, signal) => {
				await vi.advanceTimersByTimeAsync(25);
				aborted = signal.aborted;
			},
		});

		expect((await runner.tick()).performed).toBe(1);
		expect(beats).toBeGreaterThan(1);
		expect(aborted).toBe(false);
		expect(
			events.filter((event) => event.type === 'heartbeat-failed').length,
		).toBeGreaterThan(1);
	});
});

describe('the loop', () => {
	it('waits the interval between passes and starts with one immediately', async () => {
		/* An idle pass publishes no event at all, so the source itself is the
		   probe: one claim attempt is one pass. */
		let claims = 0;
		const runner = createJobRunner<Item>({
			...BASE,
			logger,
			now,
			onEvent: record,
			claim: async () => {
				claims += 1;
				return null;
			},
			perform: async () => undefined,
		});

		runner.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(claims).toBe(1);
		await vi.advanceTimersByTimeAsync(999);
		expect(claims).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(claims).toBe(2);

		await runner.quiesce();
	});

	it('keeps one scheduling chain when a stop and a start straddle a pass', async () => {
		const gate = deferred();
		let claims = 0;
		let held = true;
		const runner = createJobRunner<Item>({
			...BASE,
			logger,
			now,
			onEvent: record,
			claim: async () => {
				claims += 1;
				if (!held) return null;
				held = false;
				return { id: 'a' };
			},
			perform: async () => {
				await gate.promise;
			},
		});

		runner.start();
		await vi.advanceTimersByTimeAsync(0);
		/* The first pass is held open by the item it is performing. */
		runner.stop();
		runner.start();
		gate.resolve();
		await vi.advanceTimersByTimeAsync(0);

		const claimed = claims;
		await vi.advanceTimersByTimeAsync(10_000);
		/* Ten intervals of one chain. A second chain from the start that joined
		   the pass in flight would double this. */
		expect(claims - claimed).toBe(10);

		runner.stop();
		const stopped = claims;
		await vi.advanceTimersByTimeAsync(40);
		expect(claims - stopped).toBe(0);
		/* And the rate after a restart is the one interval again. */
		runner.start();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(claims - stopped).toBe(11);

		await runner.quiesce();
	});

	it('wakes the pass in flight with one follow-up rather than the interval', async () => {
		const gate = deferred();
		const performed: string[] = [];
		const queue: Item[] = [{ id: 'a' }];
		let claims = 0;
		const runner = createJobRunner<Item>({
			...BASE,
			concurrency: 2,
			logger,
			now,
			onEvent: record,
			claim: async () => {
				claims += 1;
				return queue.shift() ?? null;
			},
			perform: async (item) => {
				if (item.id === 'a') await gate.promise;
				performed.push(item.id);
			},
		});

		runner.start();
		await vi.advanceTimersByTimeAsync(0);
		/* The second worker has already found the queue empty, so this pass will
		   not look again however long `a` takes. */
		expect(claims).toBe(2);
		queue.push({ id: 'b' });
		runner.wake();
		runner.wake();
		gate.resolve();
		await vi.advanceTimersByTimeAsync(0);

		/* No interval passed: `b` was performed by the pass the wake asked for. */
		expect(performed).toEqual(['a', 'b']);
		/* Two wakes over one pass are one follow-up pass, not one each. */
		expect(claims).toBe(4);
		expect(events.filter((event) => event.type === 'pass-start')).toHaveLength(
			2,
		);
		await runner.quiesce();
	});

	it('wakes an idle loop with a pass of its own', async () => {
		const performed: string[] = [];
		const queue: Item[] = [];
		const runner = createJobRunner<Item>({
			...BASE,
			logger,
			now,
			onEvent: record,
			claim: async () => queue.shift() ?? null,
			perform: async (item) => {
				performed.push(item.id);
			},
		});

		queue.push({ id: 'a' });
		runner.wake();
		await vi.advanceTimersByTimeAsync(0);
		expect(performed).toEqual(['a']);

		/* A wake is one pass, not a start: nothing is scheduled behind it. */
		queue.push({ id: 'b' });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(performed).toEqual(['a']);
	});

	it('refuses a wake once the runner is disposed', async () => {
		let claims = 0;
		const runner = createJobRunner<Item>({
			...BASE,
			logger,
			now,
			onEvent: record,
			claim: async () => {
				claims += 1;
				return null;
			},
			perform: async () => undefined,
		});

		await runner.dispose();
		runner.wake();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(claims).toBe(0);
	});

	it('backs a failing pass off and a passing one back to the interval', async () => {
		let failing = true;
		let drained = false;
		const runner = createJobRunner<Item>({
			...BASE,
			batchLimit: 1,
			backoff: { initialMs: 2_000, maxMs: 8_000, multiplier: 2 },
			logger,
			now,
			onEvent: record,
			claim: async () => (drained ? null : { id: 'a' }),
			perform: async () => {
				if (failing) throw new Error('database down');
			},
		});

		await runner.tick();
		await runner.tick();
		await runner.tick();
		await runner.tick();
		expect(delaysOf()).toEqual([2_000, 4_000, 8_000, 8_000]);

		failing = false;
		await runner.tick();
		expect(delaysOf().at(-1)).toBe(1_000);

		drained = true;
		failing = true;
		/* A pass that claimed nothing raised nothing either. */
		await runner.tick();
		expect(delaysOf().at(-1)).toBe(1_000);
	});

	it('schedules the next pass after the backoff rather than the interval', async () => {
		const runner = createJobRunner<Item>({
			...BASE,
			batchLimit: 1,
			backoff: { initialMs: 5_000, maxMs: 5_000, multiplier: 2 },
			logger,
			now,
			onEvent: record,
			claim: async () => ({ id: 'a' }),
			perform: async () => {
				throw new Error('database down');
			},
		});

		runner.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(passCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(passCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(4_000);
		expect(passCount()).toBe(2);

		await runner.quiesce();
	});

	it('quiesce stops the loop and waits for the pass in flight', async () => {
		const gate = deferred();
		let finished = false;
		const runner = createJobRunner<Item>({
			...BASE,
			logger,
			now,
			onEvent: record,
			claim: queueOf('a'),
			perform: async () => {
				await gate.promise;
				finished = true;
			},
		});

		runner.start();
		await vi.advanceTimersByTimeAsync(0);
		let drained = false;
		const quiesced = runner.quiesce().then(() => {
			drained = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(drained).toBe(false);
		expect(finished).toBe(false);

		gate.resolve();
		await quiesced;
		expect(finished).toBe(true);

		/* The loop is stopped, not paused between passes. */
		await vi.advanceTimersByTimeAsync(60_000);
		expect(passCount()).toBe(1);
	});

	it('dispose after quiesce refuses every later pass', async () => {
		let claims = 0;
		const runner = createJobRunner<Item>({
			...BASE,
			logger,
			now,
			onEvent: record,
			claim: async () => {
				claims += 1;
				return null;
			},
			perform: async () => undefined,
		});

		runner.start();
		await vi.advanceTimersByTimeAsync(0);
		await runner.quiesce();
		await runner.dispose();
		expect(claims).toBe(1);

		expect(await runner.tick()).toEqual(IDLE);
		runner.start();
		runner.wake();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(claims).toBe(1);
		/* Disposal is idempotent. */
		await runner.dispose();
	});
});

describe('the trace hook', () => {
	it('publishes nothing for a pass that claimed nothing', async () => {
		const runner = createJobRunner<Item>({
			...BASE,
			logger,
			now,
			onEvent: record,
			claim: async () => null,
			perform: async () => undefined,
		});

		expect(await runner.tick()).toEqual(IDLE);
		expect(events).toEqual([]);
	});

	it('publishes the pass that claimed work, from the instant it began', async () => {
		const startedAt = clock;
		const queued: Item[] = [{ id: 'a' }];
		const runner = createJobRunner<Item>({
			...BASE,
			logger,
			now,
			onEvent: record,
			claim: async () => {
				clock += 5;
				return queued.shift() ?? null;
			},
			perform: async () => undefined,
		});

		expect((await runner.tick()).performed).toBe(1);
		expect(events.map((event) => event.type)).toEqual([
			'pass-start',
			'claimed',
			'performed',
			'pass-end',
		]);
		/* The span still covers the claim that found the work, not just what
		   followed it. */
		expect(events[0]).toEqual({
			type: 'pass-start',
			name: 'test.job',
			at: startedAt,
		});
	});

	it('costs the pass nothing when the sink throws', async () => {
		const runner = createJobRunner<Item>({
			...BASE,
			logger,
			now,
			onEvent: () => {
				throw new Error('sink defect');
			},
			claim: queueOf('a'),
			perform: async () => undefined,
		});

		expect(await runner.tick()).toEqual({
			claimed: 1,
			performed: 1,
			failed: 0,
			claimLost: 0,
		});
	});
});
