import {
	createJobRunner,
	createJobTraceSink,
	serverLogger,
	type JobBackoff,
	type JobEvent,
	type JobRunner,
	type Tracer,
} from '@flowdular/server';
import type { DeliveryAttempt, DeliveryRouting } from '../domain/types.ts';
import {
	DELIVERY_CLAIM_TIMEOUT_MS,
	DELIVERY_TICK_LIMIT,
	type DeliveryPass,
	type DeliveryService,
} from './delivery-service.ts';
import type { NotificationsRepository } from './repository.ts';

/**
 * Attempts one pass sends at the same time. Modest on purpose: it is what keeps
 * one endpoint that answers at the request timeout from holding the queue for
 * ten seconds a row, and the claims behind it stay serialized either way.
 */
export const DELIVERY_CONCURRENCY = 4;

export interface NotificationsDeliveryRunnerOptions {
	readonly repository: () => Promise<NotificationsRepository>;
	readonly deliveries: () => Promise<DeliveryService>;
	/** The platform setting, read once when the loop starts. */
	readonly intervalMs: number;
	readonly now?: (() => number) | undefined;
	/** Absent turns every pass into spans; a sink of its own replaces that. */
	readonly onEvent?: ((event: JobEvent) => void) | undefined;
	/** Defaults to the process tracer, which is the one `context.tracer` carries. */
	readonly tracer?: Tracer | undefined;
}

/** A claimed attempt, the instant it was taken, and the pass that took it. */
interface ClaimedDelivery {
	readonly attempt: DeliveryAttempt;
	readonly at: number;
	readonly pass: DeliveryPass;
}

/**
 * What a loop waits after a pass that raised: its own interval, doubling to ten
 * times that and never past a minute, so a database refusing a claim gets room
 * while a loop slower than a minute keeps its own cadence.
 */
function backoffFrom(intervalMs: number): JobBackoff {
	return {
		initialMs: intervalMs,
		maxMs: Math.max(intervalMs, Math.min(60_000, intervalMs * 10)),
		multiplier: 2,
	};
}

/**
 * The delivery queue as the platform runner sees it: a routing read that hands
 * out one attempt per claim and one attempt delivered per claim. The loop, its
 * bound, the guard against overlapping passes, the isolation of one attempt
 * from the next and the drain on stop are the runner's (`@flowdular/server`);
 * the cross-tenant queue reads, the claim under the workspace the routing row
 * named, the retry backoff and the dead letter stay in this module.
 */
export function createNotificationDeliveryRunner(
	options: NotificationsDeliveryRunnerOptions,
): JobRunner {
	/* The queue one pass works through: due attempts, then the claims a process
	   that died mid-send left behind, both on the read-only background role and
	   over routing columns alone. It is read once per pass, as the poll read it,
	   and the bound below is both pages plus the claim that finds it drained. */
	let queue: {
		readonly routing: DeliveryRouting;
		readonly pass: DeliveryPass;
	}[] = [];
	let read = false;

	return createJobRunner<ClaimedDelivery>({
		name: 'notifications.core',
		intervalMs: options.intervalMs,
		/* There is no renewal statement to fence on: a claim is held by wall clock
		   alone, and the stranded read is what hands it to another process once
		   the one holding it is gone. */
		staleAfterMs: DELIVERY_CLAIM_TIMEOUT_MS,
		backoff: backoffFrom(options.intervalMs),
		batchLimit: DELIVERY_TICK_LIMIT * 2 + 1,
		concurrency: DELIVERY_CONCURRENCY,
		logger: serverLogger,
		now: options.now,
		onEvent:
			options.onEvent ??
			createJobTraceSink(options.tracer ? { tracer: options.tracer } : {}),
		claim: async (at) => {
			if (!read) {
				const repository = await options.repository();
				const due = await repository.listDueDeliveries(at, DELIVERY_TICK_LIMIT);
				/* A claim is invisible to the due read, so a process that died between
				   claiming a row and writing its outcome would strand it. The queue is
				   asked for stale claims separately, under the same page bound. */
				const stranded = await repository.listStrandedDeliveries(
					at - DELIVERY_CLAIM_TIMEOUT_MS,
					DELIVERY_TICK_LIMIT,
				);
				/* The pass holds its workspace lookups and is dropped with the rows it
				   was read for, so a membership or an address change is picked up by
				   the pass after it. */
				const pass = (await options.deliveries()).pass();
				queue = [...due, ...stranded].map((routing) => ({ routing, pass }));
				/* Last, so a read that raised leaves the next pass to read again. */
				read = true;
			}
			for (;;) {
				const next = queue.shift();
				if (!next) {
					read = false;
					return null;
				}
				let attempt: DeliveryAttempt | null;
				try {
					attempt = await next.pass.claim(next.routing, at);
				} catch (error) {
					/* One row's claim statement raised. The row keeps its place in the
					   queue and its budget, and the rest of the page is still this
					   pass's work, so the failure is isolated here rather than ending
					   the pass on whichever row the database refused. */
					serverLogger().error('notifications.core claim failed', {
						module: 'notifications.core',
						err: error,
					});
					continue;
				}
				/* An attempt that moved since the routing read, or one another
				   process is already sending, is not work this pass performed and is
				   not counted as any. */
				if (attempt) return { attempt, at, pass: next.pass };
			}
		},
		perform: async (claimed) => {
			await claimed.pass.deliver(claimed.attempt, claimed.at);
		},
	});
}

export interface NotificationsRetentionRunnerOptions {
	readonly deliveries: () => Promise<DeliveryService>;
	readonly intervalMs: number;
	readonly now?: (() => number) | undefined;
	/** Absent turns every pass into spans; a sink of its own replaces that. */
	readonly onEvent?: ((event: JobEvent) => void) | undefined;
	/** Defaults to the process tracer, which is the one `context.tracer` carries. */
	readonly tracer?: Tracer | undefined;
}

/**
 * The retention sweep, a runner of its own rather than a tail appended to every
 * delivery pass: a tenant whose deletes raise would otherwise cost the queue
 * the rest of its pass. It claims nothing, so there is no lease and no renewal;
 * the tenant rotation and its cursor stay in the service.
 */
export function createNotificationRetentionRunner(
	options: NotificationsRetentionRunnerOptions,
): JobRunner {
	return createJobRunner<number>({
		name: 'notifications.core.retention',
		intervalMs: options.intervalMs,
		/* No claim and no renewal, so no window: the runner reads the field only
		   to space heartbeats this loop does not have. */
		staleAfterMs: options.intervalMs,
		backoff: backoffFrom(options.intervalMs),
		/* One sweep per pass: the bound of a single claim is what ends it. */
		batchLimit: 1,
		logger: serverLogger,
		now: options.now,
		onEvent:
			options.onEvent ??
			createJobTraceSink(options.tracer ? { tracer: options.tracer } : {}),
		claim: async (at) => at,
		perform: async (at) => {
			await (await options.deliveries()).collectRetention(at);
		},
	});
}
