import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	ResearchAdapterHealth,
	ResearchChainAdapterKey,
} from '../src/domain/types.ts';
import {
	retryDelay,
	runChain,
	type ChainAttempt,
	type ChainHealth,
	type ChainPolicy,
	type ChainRuntime,
	type ChainStep,
} from '../src/services/adapter-chain.ts';
import { ResearchServiceError } from '../src/services/service-error.ts';

const POLICY: ChainPolicy = {
	fallback: 'next-adapter',
	fallbackOnEmpty: true,
	retryBackoffMs: 500,
	circuitFailureThreshold: 2,
	circuitCooldownMs: 60_000,
};

/* The chain's timers and clock come from vitest's fake timers, and the jitter
   share is fixed, so every wait is an exact number of milliseconds. */
function fakeRuntime(share = 0.5): ChainRuntime {
	return {
		now: () => Date.now(),
		random: () => share,
		setTimer: (callback, ms) => setTimeout(callback, ms),
		clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
	};
}

/** The breaker state the repository keeps, in memory, with its SQL semantics. */
function memoryHealth(): ChainHealth & {
	readonly rows: Map<ResearchChainAdapterKey, ResearchAdapterHealth>;
} {
	const rows = new Map<ResearchChainAdapterKey, ResearchAdapterHealth>();
	return {
		rows,
		read: async () => [...rows.values()],
		claimProbe: async (adapter, now, until) => {
			const row = rows.get(adapter);
			if (!row || row.openUntil === null || row.openUntil > now) return false;
			rows.set(adapter, { ...row, openUntil: until });
			return true;
		},
		succeeded: async (adapter, now) => {
			const row = rows.get(adapter);
			rows.set(adapter, {
				adapter,
				consecutiveFailures: 0,
				openUntil: null,
				lastErrorCode: row?.lastErrorCode ?? null,
				lastSuccessAt: now,
			});
		},
		releaseProbe: async (adapter, claimedUntil, previous) => {
			const row = rows.get(adapter);
			if (row && row.openUntil === claimedUntil) {
				rows.set(adapter, { ...row, openUntil: previous });
			}
		},
		failed: async (adapter, code, now) => {
			const row = rows.get(adapter);
			const failures = (row?.consecutiveFailures ?? 0) + 1;
			rows.set(adapter, {
				adapter,
				consecutiveFailures: failures,
				openUntil:
					failures >= POLICY.circuitFailureThreshold
						? now + POLICY.circuitCooldownMs
						: (row?.openUntil ?? null),
				lastErrorCode: code,
				lastSuccessAt: row?.lastSuccessAt ?? null,
			});
		},
	};
}

type Script = readonly (string[] | Error | 'hang')[];

/** A step answering from a script, one entry per call; the last entry repeats. */
function step(
	key: ResearchChainAdapterKey,
	script: Script,
	options: Partial<ChainStep<string[]>> = {},
): ChainStep<string[]> & { calls: number[] } {
	const calls: number[] = [];
	return {
		key,
		maxAttempts: 2,
		timeoutMs: 1_000,
		breaker: true,
		calls,
		empty: (result) => result.length === 0,
		run: (signal) => {
			calls.push(Date.now());
			const entry = script[Math.min(calls.length - 1, script.length - 1)]!;
			if (entry === 'hang') {
				return new Promise<string[]>((_, reject) =>
					signal.addEventListener('abort', () => reject(new Error('aborted'))),
				);
			}
			return entry instanceof Error
				? Promise.reject(entry)
				: Promise.resolve(entry);
		},
		...options,
	};
}

function retryable(code = 'RESEARCH_CONNECTOR_FAILED', retryAfterMs?: number) {
	return new ResearchServiceError(code, 'retryable', 502, {
		retryable: true,
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	});
}

function permanent(code = 'RESEARCH_ADAPTER_UNAUTHORIZED') {
	return new ResearchServiceError(code, 'permanent', 502);
}

beforeEach(() => {
	vi.useFakeTimers({ now: Date.parse('2026-09-16T10:00:00Z') });
});

afterEach(() => {
	vi.useRealTimers();
});

describe('research adapter chain', () => {
	it('RESEARCH-CHAIN-ORDER tries the adapters in order and names the one that answered', async () => {
		const first = step('searxng', [permanent()]);
		const second = step('firecrawl', [['https://a.example.org/']]);
		const third = step('recorded', [['never']]);
		const attempts: ChainAttempt[] = [];

		const answer = await runChain({
			steps: [first, second, third],
			policy: POLICY,
			health: memoryHealth(),
			attempts,
			runtime: fakeRuntime(),
		});

		expect(answer).toMatchObject({ adapter: 'firecrawl', empty: false });
		expect([
			first.calls.length,
			second.calls.length,
			third.calls.length,
		]).toEqual([1, 1, 0]);
		expect(
			attempts.map((entry) => [entry.adapter, entry.attempt, entry.outcome]),
		).toEqual([
			['searxng', 1, 'permanent'],
			['firecrawl', 1, 'ok'],
		]);
	});

	it('RESEARCH-CHAIN-RETRY waits the full jitter delay before a retry and never retries a permanent failure', async () => {
		const flaky = step('searxng', [retryable(), retryable(), ['found']], {
			maxAttempts: 3,
		});
		const attempts: ChainAttempt[] = [];
		const running = runChain({
			steps: [flaky],
			policy: POLICY,
			health: memoryHealth(),
			attempts,
			runtime: fakeRuntime(0.5),
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(flaky.calls).toHaveLength(1);
		/* First retry: half of 500. */
		await vi.advanceTimersByTimeAsync(249);
		expect(flaky.calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(flaky.calls).toHaveLength(2);
		/* Second retry: half of the doubled 1000. */
		await vi.advanceTimersByTimeAsync(499);
		expect(flaky.calls).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		await expect(running).resolves.toMatchObject({ adapter: 'searxng' });
		expect(attempts.map((entry) => entry.outcome)).toEqual([
			'retryable',
			'retryable',
			'ok',
		]);

		const refused = step('firecrawl', [permanent()], { maxAttempts: 5 });
		await expect(
			runChain({
				steps: [refused],
				policy: POLICY,
				health: memoryHealth(),
				attempts: [],
				runtime: fakeRuntime(),
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_ADAPTER_UNAUTHORIZED' });
		expect(refused.calls).toHaveLength(1);
	});

	it('RESEARCH-CHAIN-RETRY treats a timeout as retryable and caps the backoff at five seconds', async () => {
		const slow = step('searxng', ['hang', ['late']], { timeoutMs: 1_000 });
		const attempts: ChainAttempt[] = [];
		const running = runChain({
			steps: [slow],
			policy: { ...POLICY, retryBackoffMs: 5_000 },
			health: memoryHealth(),
			attempts,
			runtime: fakeRuntime(0.999),
		});
		await vi.advanceTimersByTimeAsync(1_000);
		expect(attempts).toEqual([
			expect.objectContaining({
				outcome: 'retryable',
				errorCode: 'RESEARCH_ADAPTER_TIMEOUT',
				durationMs: 1_000,
			}),
		]);
		await vi.advanceTimersByTimeAsync(4_994);
		expect(slow.calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(running).resolves.toMatchObject({ result: ['late'] });

		expect(retryDelay(4, 5_000, null, () => 0.999)).toBe(4_995);
		expect(retryDelay(1, 500, null, () => 0)).toBe(0);
	});

	it('RESEARCH-RETRY-AFTER honours Retry-After on a 429 and caps it at five seconds', async () => {
		const limited = step('firecrawl', [
			retryable('RESEARCH_ADAPTER_RATE_LIMITED', 2_000),
			['ok'],
		]);
		const running = runChain({
			steps: [limited],
			policy: POLICY,
			health: memoryHealth(),
			attempts: [],
			runtime: fakeRuntime(0),
		});
		await vi.advanceTimersByTimeAsync(1_999);
		expect(limited.calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(running).resolves.toMatchObject({ adapter: 'firecrawl' });

		const patient = step('firecrawl', [
			retryable('RESEARCH_ADAPTER_RATE_LIMITED', 60_000),
			['ok'],
		]);
		const capped = runChain({
			steps: [patient],
			policy: POLICY,
			health: memoryHealth(),
			attempts: [],
			runtime: fakeRuntime(0),
		});
		await vi.advanceTimersByTimeAsync(4_999);
		expect(patient.calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(capped).resolves.toMatchObject({ result: ['ok'] });
	});

	it('RESEARCH-CHAIN-FALLBACK moves on, fails fast, and keeps an empty answer only as the last resort', async () => {
		const next = await runChain({
			steps: [step('searxng', [permanent()]), step('recorded', [['r']])],
			policy: POLICY,
			health: memoryHealth(),
			attempts: [],
			runtime: fakeRuntime(),
		});
		expect(next.adapter).toBe('recorded');

		const second = step('recorded', [['r']]);
		await expect(
			runChain({
				steps: [step('searxng', [permanent()]), second],
				policy: { ...POLICY, fallback: 'fail' },
				health: memoryHealth(),
				attempts: [],
				runtime: fakeRuntime(),
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_ADAPTER_UNAUTHORIZED' });
		expect(second.calls).toHaveLength(0);

		const onEmpty = await runChain({
			steps: [step('searxng', [[]]), step('recorded', [['r']])],
			policy: POLICY,
			health: memoryHealth(),
			attempts: [],
			runtime: fakeRuntime(),
		});
		expect(onEmpty).toMatchObject({ adapter: 'recorded', empty: false });

		const stayEmpty = step('recorded', [['r']]);
		const kept = await runChain({
			steps: [step('searxng', [[]]), stayEmpty],
			policy: { ...POLICY, fallbackOnEmpty: false },
			health: memoryHealth(),
			attempts: [],
			runtime: fakeRuntime(),
		});
		expect(kept).toMatchObject({ adapter: 'searxng', empty: true });
		expect(stayEmpty.calls).toHaveLength(0);

		const lastResort = await runChain({
			steps: [step('searxng', [[]]), step('recorded', [permanent()])],
			policy: POLICY,
			health: memoryHealth(),
			attempts: [],
			runtime: fakeRuntime(),
		});
		expect(lastResort).toMatchObject({ adapter: 'searxng', empty: true });
	});

	it('ends the chain at once on a policy refusal and on a cancelled request', async () => {
		const after = step('firecrawl', [['never']]);
		await expect(
			runChain({
				steps: [
					step('direct', [
						new ResearchServiceError('RESEARCH_ROBOTS_DISALLOWED', 'no', 403),
					]),
					after,
				],
				policy: POLICY,
				health: memoryHealth(),
				attempts: [],
				runtime: fakeRuntime(),
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_ROBOTS_DISALLOWED' });
		expect(after.calls).toHaveLength(0);

		const controller = new AbortController();
		const waiting = step('searxng', ['hang'], { timeoutMs: 10_000 });
		const running = runChain({
			steps: [waiting, step('recorded', [['r']])],
			policy: POLICY,
			health: memoryHealth(),
			attempts: [],
			signal: controller.signal,
			runtime: fakeRuntime(),
		});
		const outcome = expect(running).rejects.toMatchObject({
			code: 'RESEARCH_REQUEST_CANCELLED',
		});
		await vi.advanceTimersByTimeAsync(10);
		controller.abort();
		await outcome;
	});

	it('RESEARCH-CIRCUIT skips an open adapter, lets one half open probe through, and closes on success', async () => {
		const health = memoryHealth();
		const failing = () => step('searxng', [permanent()], { maxAttempts: 1 });
		const working = () => step('recorded', [['r']]);
		const run = (steps: ChainStep<string[]>[], attempts: ChainAttempt[] = []) =>
			runChain({
				steps,
				policy: POLICY,
				health,
				attempts,
				runtime: fakeRuntime(),
			});

		await run([failing(), working()]);
		expect(health.rows.get('searxng')).toMatchObject({
			consecutiveFailures: 1,
			openUntil: null,
		});
		await run([failing(), working()]);
		const openedAt = Date.now();
		expect(health.rows.get('searxng')).toMatchObject({
			consecutiveFailures: 2,
			openUntil: openedAt + 60_000,
			lastErrorCode: 'RESEARCH_ADAPTER_UNAUTHORIZED',
		});

		const skipped = failing();
		const attempts: ChainAttempt[] = [];
		await run([skipped, working()], attempts);
		expect(skipped.calls).toHaveLength(0);
		expect(attempts[0]).toMatchObject({
			adapter: 'searxng',
			attempt: 0,
			outcome: 'skipped-circuit',
		});

		/* After the cooldown one probe runs and fails: open again for a full cooldown. */
		vi.setSystemTime(openedAt + 60_000);
		const probe = failing();
		await run([probe, working()]);
		expect(probe.calls).toHaveLength(1);
		expect(health.rows.get('searxng')?.openUntil).toBe(openedAt + 120_000);

		/* Two queries after the next cooldown: only the one holding the probe asks. */
		vi.setSystemTime(openedAt + 120_000);
		const racing = [step('searxng', [['back']]), step('searxng', [['back']])];
		await Promise.all(racing.map((entry) => run([entry, working()])));
		expect(racing.map((entry) => entry.calls.length).sort()).toEqual([0, 1]);
		expect(health.rows.get('searxng')).toMatchObject({
			consecutiveFailures: 0,
			openUntil: null,
			lastSuccessAt: openedAt + 120_000,
		});
	});

	it('RESEARCH-CIRCUIT hands the probe back when it ends without a verdict', async () => {
		const health = memoryHealth();
		const openedAt = Date.now() - 1;
		health.rows.set('searxng', {
			adapter: 'searxng',
			consecutiveFailures: 2,
			openUntil: openedAt,
			lastErrorCode: 'RESEARCH_ADAPTER_UNAUTHORIZED',
			lastSuccessAt: null,
		});
		const unconfigured = step('searxng', [
			new ResearchServiceError('RESEARCH_ADAPTER_UNAVAILABLE', 'no', 409),
		]);
		await runChain({
			steps: [unconfigured, step('recorded', [['r']])],
			policy: POLICY,
			health,
			attempts: [],
			runtime: fakeRuntime(),
		});
		expect(unconfigured.calls).toHaveLength(1);
		expect(health.rows.get('searxng')?.openUntil).toBe(openedAt);

		await expect(
			runChain({
				steps: [step('searxng', [['found']]), step('recorded', [['r']])],
				policy: POLICY,
				health,
				attempts: [],
				runtime: fakeRuntime(),
				beforeAttempt: async () => {
					throw new ResearchServiceError(
						'RESEARCH_BUDGET_EXCEEDED',
						'spent',
						429,
					);
				},
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_BUDGET_EXCEEDED' });
		expect(health.rows.get('searxng')?.openUntil).toBe(openedAt);

		const probe = step('searxng', [['back']]);
		await runChain({
			steps: [probe],
			policy: POLICY,
			health,
			attempts: [],
			runtime: fakeRuntime(),
		});
		expect(probe.calls).toHaveLength(1);
		expect(health.rows.get('searxng')).toMatchObject({
			openUntil: null,
			consecutiveFailures: 0,
		});
	});

	it('never counts a failure that is not the adapter own towards the circuit', async () => {
		const health = memoryHealth();
		for (let index = 0; index < 3; index += 1) {
			await runChain({
				steps: [
					step('model-native', [
						new ResearchServiceError('RESEARCH_ADAPTER_UNAVAILABLE', 'no', 409),
					]),
					step('firecrawl', [
						new ResearchServiceError('RESEARCH_FETCH_FAILED', 'page', 502, {
							health: false,
						}),
					]),
					step('recorded', [['r']]),
				],
				policy: POLICY,
				health,
				attempts: [],
				runtime: fakeRuntime(),
			});
		}
		expect(health.rows.has('model-native')).toBe(false);
		expect(health.rows.has('firecrawl')).toBe(false);
	});
});
