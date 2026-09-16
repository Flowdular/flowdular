import {
	RESEARCH_CHAIN_LIMITS,
	type ResearchAdapterHealth,
	type ResearchAdapterKey,
	type ResearchAttemptOutcome,
	type ResearchChainAdapterKey,
	type ResearchFallbackMode,
	type ResearchSettings,
} from '../domain/types.ts';
import { ResearchServiceError } from './service-error.ts';

/* A policy refusal ends a chain at once: a second adapter reading the same
   page would only route around the workspace's own rules. */
const FINAL_CODES = new Set([
	'INVALID_INPUT',
	'RESEARCH_BUDGET_EXCEEDED',
	'RESEARCH_DOMAIN_DENIED',
	'RESEARCH_ROBOTS_DISALLOWED',
	'RESEARCH_ROBOTS_UNAVAILABLE',
	'RESEARCH_EGRESS_REFUSED',
	'RESEARCH_EGRESS_UNAVAILABLE',
	'RESEARCH_REDIRECT_REFUSED',
	'RESEARCH_FETCH_TOO_LARGE',
	'RESEARCH_CONTENT_UNSUPPORTED',
	'RESEARCH_URL_INVALID',
	'RESEARCH_RUN_LIMIT',
	'RESEARCH_REQUEST_CANCELLED',
]);

/* Not the adapter's fault, so never a step towards an open circuit. */
const HEALTHLESS_CODES = new Set([
	/* Counted once, when the provider's report arrives. */
	'NATIVE_TOOL_UNSUPPORTED',
	'TOOL_NOT_CONSENTED',
	'RESEARCH_ADAPTER_UNAVAILABLE',
	'RESEARCH_FIXTURES_UNAVAILABLE',
	'RESEARCH_PAGE_NOT_RECORDED',
]);

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface ChainAttempt {
	readonly adapter: ResearchChainAdapterKey;
	readonly attempt: number;
	readonly outcome: ResearchAttemptOutcome;
	readonly errorCode: string | null;
	readonly durationMs: number;
	readonly createdAt: number;
}

export interface ChainStep<T> {
	readonly key: ResearchChainAdapterKey;
	readonly maxAttempts: number;
	readonly timeoutMs: number;
	/** Whether the circuit breaker may skip this adapter and counts its failures. */
	readonly breaker: boolean;
	run(signal: AbortSignal): Promise<T>;
	empty(result: T): boolean;
}

export interface ChainPolicy {
	readonly fallback: ResearchFallbackMode;
	readonly fallbackOnEmpty: boolean;
	readonly retryBackoffMs: number;
	readonly circuitFailureThreshold: number;
	readonly circuitCooldownMs: number;
	/** The Test action asks an adapter that the breaker would skip. */
	readonly ignoreCircuit?: boolean;
}

export interface ChainHealth {
	read(): Promise<readonly ResearchAdapterHealth[]>;
	/** Takes the one half open probe; false when another query already took it. */
	claimProbe(
		adapter: ResearchChainAdapterKey,
		now: number,
		until: number,
	): Promise<boolean>;
	succeeded(adapter: ResearchChainAdapterKey, now: number): Promise<void>;
	failed(
		adapter: ResearchChainAdapterKey,
		code: string,
		now: number,
	): Promise<void>;
	/** Puts back the open time a probe moved, unless something wrote it since. */
	releaseProbe(
		adapter: ResearchChainAdapterKey,
		claimedUntil: number,
		previous: number,
	): Promise<void>;
}

export interface ChainRuntime {
	readonly now: () => number;
	/** A number in [0, 1); the full jitter share of a retry delay. */
	readonly random: () => number;
	readonly setTimer: (callback: () => void, ms: number) => unknown;
	readonly clearTimer: (timer: unknown) => void;
}

export const SYSTEM_CHAIN_RUNTIME: ChainRuntime = {
	now: Date.now,
	random: Math.random,
	setTimer: (callback, ms) => setTimeout(callback, ms),
	clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export interface ChainAnswer<T> {
	readonly adapter: ResearchChainAdapterKey;
	readonly result: T;
	readonly empty: boolean;
}

interface Failure {
	readonly kind: 'retryable' | 'permanent' | 'final';
	readonly code: string;
	readonly retryAfterMs: number | null;
	readonly health: boolean;
	readonly error: unknown;
}

function cancelled(): ResearchServiceError {
	return new ResearchServiceError(
		'RESEARCH_REQUEST_CANCELLED',
		'The request was cancelled.',
		499,
	);
}

export function adapterTimeout(timeoutMs: number): ResearchServiceError {
	return new ResearchServiceError(
		'RESEARCH_ADAPTER_TIMEOUT',
		`The adapter did not answer within ${timeoutMs} milliseconds.`,
		504,
		{ retryable: true },
	);
}

export function classifyFailure(error: unknown): Failure {
	if (error instanceof ResearchServiceError) {
		const traits = error.traits;
		return {
			kind: FINAL_CODES.has(error.code)
				? 'final'
				: traits.retryable === true
					? 'retryable'
					: 'permanent',
			code: error.code,
			retryAfterMs: traits.retryAfterMs ?? null,
			health: traits.health ?? !HEALTHLESS_CODES.has(error.code),
			error,
		};
	}
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === 'string' && CODE.test(code)) {
		return {
			kind: 'permanent',
			code,
			retryAfterMs: null,
			health: true,
			error: new ResearchServiceError(
				code,
				error instanceof Error ? error.message : 'The adapter refused.',
				502,
			),
		};
	}
	return {
		kind: 'retryable',
		code: 'RESEARCH_ADAPTER_FAILED',
		retryAfterMs: null,
		health: true,
		error: new ResearchServiceError(
			'RESEARCH_ADAPTER_FAILED',
			'The adapter failed unexpectedly.',
			502,
			{ retryable: true },
		),
	};
}

/**
 * Full jitter: a random share of the doubled base, capped. A provider's
 * Retry-After replaces the jitter and is capped the same way.
 */
export function retryDelay(
	retry: number,
	baseMs: number,
	retryAfterMs: number | null,
	random: () => number,
): number {
	const cap = RESEARCH_CHAIN_LIMITS.backoffCapMs;
	if (retryAfterMs !== null) return Math.min(cap, Math.max(0, retryAfterMs));
	const ceiling = Math.min(cap, baseMs * 2 ** (retry - 1));
	return Math.floor(random() * ceiling);
}

function sleep(
	ms: number,
	signal: AbortSignal | undefined,
	runtime: ChainRuntime,
): Promise<void> {
	if (signal?.aborted) return Promise.reject(cancelled());
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			runtime.clearTimer(timer);
			reject(cancelled());
		};
		const timer = runtime.setTimer(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

async function bounded<T>(
	step: ChainStep<T>,
	signal: AbortSignal | undefined,
	runtime: ChainRuntime,
): Promise<T> {
	if (signal?.aborted) throw cancelled();
	const controller = new AbortController();
	let timer: unknown;
	let release = (): void => undefined;
	const stopped = new Promise<never>((_, reject) => {
		/* Rejected before the abort reaches the adapter, so the race answers the
		   timeout or the cancellation rather than whatever the adapter throws. */
		timer = runtime.setTimer(() => {
			reject(adapterTimeout(step.timeoutMs));
			controller.abort();
		}, step.timeoutMs);
		if (signal) {
			const onAbort = () => {
				reject(cancelled());
				controller.abort();
			};
			signal.addEventListener('abort', onAbort, { once: true });
			release = () => signal.removeEventListener('abort', onAbort);
		}
	});
	const running = step.run(controller.signal);
	/* The losing side of the race settles later and must not surface as an
	   unhandled rejection. */
	running.catch(() => undefined);
	stopped.catch(() => undefined);
	try {
		return await Promise.race([running, stopped]);
	} finally {
		runtime.clearTimer(timer);
		release();
	}
}

/**
 * Runs the steps in order under the retry, fallback and breaker policy. Every
 * attempt is appended to `attempts`, which the caller writes whether the chain
 * answered or not. `beforeAttempt` runs ahead of every attempt, outside the
 * attempt record, so a refusal there (the budget) ends the chain unrecorded.
 */
export async function runChain<T>(input: {
	readonly steps: readonly ChainStep<T>[];
	readonly policy: ChainPolicy;
	readonly health: ChainHealth;
	readonly attempts: ChainAttempt[];
	readonly signal?: AbortSignal | undefined;
	readonly runtime?: ChainRuntime;
	readonly beforeAttempt?: (step: ChainStep<T>) => Promise<void>;
}): Promise<ChainAnswer<T>> {
	const runtime = input.runtime ?? SYSTEM_CHAIN_RUNTIME;
	const { policy, attempts } = input;
	const health = input.steps.some(
		(step) => step.breaker && policy.ignoreCircuit !== true,
	)
		? new Map((await input.health.read()).map((row) => [row.adapter, row]))
		: new Map<ResearchChainAdapterKey, ResearchAdapterHealth>();
	let emptyAnswer: ChainAnswer<T> | null = null;
	let lastFailure: unknown = null;

	/* One adapter, attempt by attempt: an answer, an empty answer, or the
	   failure that exhausted it. A final failure throws. */
	const tryStep = async (
		step: ChainStep<T>,
	): Promise<
		| { readonly kind: 'answer'; readonly answer: ChainAnswer<T> }
		| { readonly kind: 'failed'; readonly failure: Failure }
	> => {
		let failure: Failure | null = null;
		for (let attempt = 1; attempt <= step.maxAttempts; attempt += 1) {
			if (attempt > 1) {
				await sleep(
					retryDelay(
						attempt - 1,
						policy.retryBackoffMs,
						failure?.retryAfterMs ?? null,
						runtime.random,
					),
					input.signal,
					runtime,
				);
			}
			await input.beforeAttempt?.(step);
			const started = runtime.now();
			let result: T;
			let empty: boolean;
			try {
				result = await bounded(step, input.signal, runtime);
				empty = step.empty(result);
			} catch (error) {
				failure = classifyFailure(error);
				attempts.push({
					adapter: step.key,
					attempt,
					outcome: failure.kind === 'retryable' ? 'retryable' : 'permanent',
					errorCode: failure.code,
					durationMs: Math.max(0, runtime.now() - started),
					createdAt: started,
				});
				if (failure.kind === 'final') throw failure.error;
				if (failure.kind === 'permanent') break;
				continue;
			}
			attempts.push({
				adapter: step.key,
				attempt,
				outcome: empty ? 'empty' : 'ok',
				errorCode: null,
				durationMs: Math.max(0, runtime.now() - started),
				createdAt: started,
			});
			if (step.breaker) await input.health.succeeded(step.key, runtime.now());
			return { kind: 'answer', answer: { adapter: step.key, result, empty } };
		}
		return { kind: 'failed', failure: failure! };
	};

	for (const [index, step] of input.steps.entries()) {
		const later = index < input.steps.length - 1;
		if (input.signal?.aborted) throw cancelled();
		let probe: { readonly until: number; readonly previous: number } | null =
			null;
		if (step.breaker && policy.ignoreCircuit !== true) {
			const state = health.get(step.key);
			if (state && state.openUntil !== null) {
				const now = runtime.now();
				const until = now + policy.circuitCooldownMs;
				if (
					now >= state.openUntil &&
					(await input.health.claimProbe(step.key, now, until))
				) {
					probe = { until, previous: state.openUntil };
				} else {
					attempts.push({
						adapter: step.key,
						attempt: 0,
						outcome: 'skipped-circuit',
						errorCode: null,
						durationMs: 0,
						createdAt: now,
					});
					continue;
				}
			}
		}
		let settled = false;
		let outcome: Awaited<ReturnType<typeof tryStep>>;
		try {
			outcome = await tryStep(step);
			if (outcome.kind === 'answer') {
				settled = step.breaker;
			} else if (step.breaker && outcome.failure.health) {
				await input.health.failed(
					step.key,
					outcome.failure.code,
					runtime.now(),
				);
				settled = true;
			}
		} finally {
			/* A probe that ended without a verdict (cancelled, refused by the
			   budget or by a failure that is not the adapter's own) hands the
			   probe back instead of pausing the adapter for another cooldown. */
			if (probe && !settled) {
				await input.health
					.releaseProbe(step.key, probe.until, probe.previous)
					.catch(() => undefined);
			}
		}
		if (outcome.kind === 'answer') {
			const { answer } = outcome;
			if (!answer.empty) return answer;
			if (!(policy.fallbackOnEmpty && later)) return emptyAnswer ?? answer;
			emptyAnswer ??= answer;
			continue;
		}
		lastFailure = outcome.failure.error;
		if (policy.fallback === 'fail') break;
	}
	if (emptyAnswer) return emptyAnswer;
	throw (
		lastFailure ??
		new ResearchServiceError(
			'RESEARCH_ADAPTER_UNAVAILABLE',
			'No adapter could answer: every adapter is switched off or paused after repeated failures.',
			503,
		)
	);
}

/**
 * The search chain in the owner's order. While searchOrder is empty it is the
 * single adapter setting, whatever that adapter's switch says.
 */
export function searchChainKeys(
	settings: ResearchSettings,
): readonly ResearchAdapterKey[] {
	if (settings.searchOrder.length === 0) return [settings.adapter];
	return settings.searchOrder.filter((key) => settings.limits[key].enabled);
}
