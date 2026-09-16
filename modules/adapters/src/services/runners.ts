import { randomUUID } from 'node:crypto';
import {
	createJobRunner,
	createJobTraceSink,
	jobBackoff,
	serverLogger,
	type JobEvent,
	type JobRunner,
} from '@flowdular/server';
import {
	ADAPTER_LIMITS,
	type AdapterDueBinding,
	type AdapterRun,
	type AdapterRunRouting,
} from '../domain/types.ts';
import type { AdaptersService } from './adapters-service.ts';
import type { AdaptersRepository } from './repository.ts';

/** How often both loops look for work. A constant, as import.core's is. */
export const ADAPTERS_POLL_INTERVAL_MS = 2_000;

/**
 * Five minutes: a page with its three attempts, each bounded by the connector
 * call timeout, fits many times over, and a dead process is taken over soon.
 */
export const ADAPTERS_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

export interface AdapterRunnerOptions {
	readonly repository: () => Promise<AdaptersRepository>;
	readonly service: () => Promise<AdaptersService>;
	readonly claimTimeoutMs?: number | undefined;
	readonly pollIntervalMs?: number | undefined;
	readonly heartbeatEveryMs?: number | undefined;
	readonly now?: (() => number) | undefined;
	readonly onEvent?: ((event: JobEvent) => void) | undefined;
}

interface ClaimedRun {
	readonly run: AdapterRun;
	readonly claimedBy: string;
}

/**
 * Walks a routing page the way import.core does: the page is refilled only
 * once it is drained, and the rows one pass walks past are bounded, so a queue
 * other processes hold cannot cost one routing read per row.
 */
function routingQueue<Routing, Claimed>(
	read: (at: number) => Promise<readonly Routing[]>,
	take: (routing: Routing, at: number) => Promise<Claimed | null>,
): (at: number) => Promise<Claimed | null> {
	let queue: Routing[] = [];
	let refillable = true;
	let skipped = 0;
	return async (at) => {
		while (skipped < ADAPTER_LIMITS.routingPage) {
			if (queue.length === 0) {
				if (!refillable) break;
				const page = await read(at);
				refillable = page.length === ADAPTER_LIMITS.routingPage;
				queue = [...page];
				if (queue.length === 0) break;
			}
			const claimed = await take(queue.shift()!, at);
			if (claimed) return claimed;
			skipped += 1;
		}
		skipped = 0;
		refillable = true;
		queue = [];
		return null;
	};
}

/** The run loop: a claim with a lease, a fenced renewal and one run performed. */
export function createAdapterRunRunner(
	options: AdapterRunnerOptions,
): JobRunner {
	const staleAfterMs = options.claimTimeoutMs ?? ADAPTERS_CLAIM_TIMEOUT_MS;
	const intervalMs = options.pollIntervalMs ?? ADAPTERS_POLL_INTERVAL_MS;
	return createJobRunner<ClaimedRun>({
		name: 'adapters.core.runs',
		intervalMs,
		staleAfterMs,
		backoff: jobBackoff(intervalMs),
		batchLimit: ADAPTER_LIMITS.routingPage,
		heartbeatEveryMs: options.heartbeatEveryMs,
		logger: serverLogger,
		now: options.now,
		onEvent: options.onEvent ?? createJobTraceSink(),
		claim: routingQueue<AdapterRunRouting, ClaimedRun>(
			async (at) =>
				(await options.repository()).listPendingRuns(
					at,
					ADAPTER_LIMITS.routingPage,
				),
			async (routing, at) => {
				const claimedBy = randomUUID();
				const run = await (
					await options.repository()
				).claimRun({
					tenantId: routing.tenantId,
					id: routing.id,
					claimedBy,
					at,
					leaseUntil: at + staleAfterMs,
				});
				return run ? { run, claimedBy } : null;
			},
		),
		heartbeat: async (claimed, at) =>
			(await options.repository()).heartbeatRun(
				claimed.run.tenantId,
				claimed.run.id,
				claimed.claimedBy,
				at + staleAfterMs,
			),
		perform: async (claimed, signal) => {
			await (
				await options.service()
			).perform(claimed.run, claimed.claimedBy, signal);
			/* A lost claim is recorded by recording nothing; raising the abort
			   tells the pass the item was contention rather than work done. */
			signal.throwIfAborted();
		},
	});
}

/**
 * The schedule loop. It claims nothing of its own: the compare and swap on the
 * binding's next time inside `fire` is the fence, so it has no heartbeat.
 */
export function createAdapterScheduleRunner(
	options: AdapterRunnerOptions,
): JobRunner {
	const intervalMs = options.pollIntervalMs ?? ADAPTERS_POLL_INTERVAL_MS;
	return createJobRunner<AdapterDueBinding>({
		name: 'adapters.core.schedule',
		intervalMs,
		staleAfterMs: options.claimTimeoutMs ?? ADAPTERS_CLAIM_TIMEOUT_MS,
		backoff: jobBackoff(intervalMs),
		batchLimit: ADAPTER_LIMITS.routingPage,
		logger: serverLogger,
		now: options.now,
		onEvent: options.onEvent ?? createJobTraceSink(),
		claim: routingQueue<AdapterDueBinding, AdapterDueBinding>(
			async (at) =>
				(await options.repository()).listDueBindings(
					at,
					ADAPTER_LIMITS.routingPage,
				),
			async (due) => due,
		),
		perform: async (due) => {
			await (await options.service()).fire(due);
		},
	});
}
