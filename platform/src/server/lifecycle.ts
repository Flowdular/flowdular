import process from 'node:process';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { BroadcastChannel } from 'node:worker_threads';
import type { Middleware } from '@octanejs/app-core';

export const PLATFORM_LIFECYCLE_SYMBOL = Symbol.for(
	'coreloom.platform.runtime-lifecycle',
);
export const PLATFORM_LIFECYCLE_ACTIVATE_EVENT =
	'coreloom:platform-runtime-activate';
export const PLATFORM_LIFECYCLE_RETIRE_EVENT =
	'coreloom:platform-runtime-retire';
const PLATFORM_LIFECYCLE_CHANNEL = 'coreloom.platform.runtime-lifecycle';

type Dispose = () => void | Promise<void>;

export interface PlatformRuntimeLifecycle {
	readonly middleware: Middleware;
	addQuiesce(quiesce: Dispose): void;
	add(dispose: Dispose): void;
	retire(): Promise<void>;
}

type ProcessWithLifecycle = NodeJS.Process & {
	[PLATFORM_LIFECYCLE_SYMBOL]?: PlatformRuntimeLifecycle;
};

/* Vite evaluates octane.config.ts again when one of its SSR dependencies is
	invalidated. A generation owns every resource created by that evaluation.
	Retirement waits for requests already using the old route closures, then
	disposes its resources in reverse composition order. */
export function createPlatformRuntimeLifecycle(): PlatformRuntimeLifecycle {
	const disposers: Dispose[] = [];
	const quiescers: Dispose[] = [];
	let activeRequests = 0;
	let retired = false;
	let finishing = false;
	let disposal: Promise<void> | undefined;
	let resolveDisposal: (() => void) | undefined;
	let rejectDisposal: ((error: unknown) => void) | undefined;

	const finish = () => {
		if (!retired || activeRequests !== 0 || disposal === undefined || finishing)
			return;
		finishing = true;
		const currentQuiescers = quiescers.splice(0).reverse();
		const current = disposers.splice(0).reverse();
		void (async () => {
			const failures: unknown[] = [];
			/* Every background producer stops before any module repository closes. */
			for (const quiesce of currentQuiescers) {
				try {
					await quiesce();
				} catch (error) {
					failures.push(error);
				}
			}
			for (const dispose of current) {
				try {
					await dispose();
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length > 0) {
				rejectDisposal?.(
					new AggregateError(
						failures,
						'Platform runtime teardown did not release every resource.',
					),
				);
			} else {
				resolveDisposal?.();
			}
		})();
	};

	const lifecycle: PlatformRuntimeLifecycle = {
		middleware: async (_context, next) => {
			if (retired) {
				return new Response(null, {
					status: 503,
					headers: { 'retry-after': '1' },
				});
			}
			activeRequests += 1;
			try {
				return await next();
			} finally {
				activeRequests -= 1;
				finish();
			}
		},
		addQuiesce(quiesce) {
			if (retired) {
				void Promise.resolve()
					.then(quiesce)
					.catch((error: unknown) => {
						console.error('[coreloom] late platform quiesce failed', error);
					});
				return;
			}
			quiescers.push(quiesce);
		},
		add(dispose) {
			if (retired) {
				void Promise.resolve()
					.then(dispose)
					.catch((error: unknown) => {
						console.error('[coreloom] late platform teardown failed', error);
					});
				return;
			}
			disposers.push(dispose);
		},
		retire() {
			if (!disposal) {
				disposal = new Promise<void>((resolve, reject) => {
					resolveDisposal = resolve;
					rejectDisposal = reject;
				});
				retired = true;
				finish();
			}
			return disposal;
		},
	};
	return lifecycle;
}

/* Activation happens only after the new configuration composed successfully.
	A failed HMR evaluation therefore tears down only its partial generation and
	leaves the previous, still-routable generation alive. */
export function activatePlatformRuntimeLifecycle(
	lifecycle: PlatformRuntimeLifecycle,
): Promise<void> {
	const owner = process as ProcessWithLifecycle;
	const events = process as unknown as EventEmitter;
	const generationId = `${process.pid}:${randomUUID()}`;
	const channel = new BroadcastChannel(PLATFORM_LIFECYCLE_CHANNEL);
	channel.unref();
	const previous = owner[PLATFORM_LIFECYCLE_SYMBOL];
	owner[PLATFORM_LIFECYCLE_SYMBOL] = lifecycle;
	/* Octane loads its config once through the Vite config loader and again
	   through the SSR module runner. Their process wrappers do not share custom
	   properties, but both delegate EventEmitter operations to the real process.
	   The event is therefore the cross-runner ownership handoff. */
	const onActivation = (
		next: PlatformRuntimeLifecycle,
		report?: (retirement: Promise<void>) => void,
	) => {
		if (next === lifecycle) return;
		const retirement = lifecycle.retire();
		report?.(retirement);
		void retirement.catch((error: unknown) => {
			console.error('[coreloom] stale platform teardown failed', error);
		});
	};
	const onRetire = (report: (retirement: Promise<void>) => void) => {
		report(lifecycle.retire());
	};
	channel.onmessage = (event) => {
		if (!event.data || typeof event.data !== 'object') return;
		const message = event.data as { type?: unknown; generationId?: unknown };
		if (
			message.type !== 'retire-all' &&
			(message.type !== 'activate' || message.generationId === generationId)
		) {
			return;
		}
		/* Closing a BroadcastChannel from inside its own callback can wait for the
		   callback to return. Start retirement in the next microtask so channel
		   teardown cannot deadlock the generation it is releasing. */
		queueMicrotask(() => {
			void lifecycle.retire().catch((error: unknown) => {
				console.error(
					'[coreloom] cross-runner platform teardown failed',
					error,
				);
			});
		});
	};
	events.on(PLATFORM_LIFECYCLE_ACTIVATE_EVENT, onActivation);
	events.on(PLATFORM_LIFECYCLE_RETIRE_EVENT, onRetire);
	lifecycle.add(() => {
		channel.close();
		events.off(PLATFORM_LIFECYCLE_ACTIVATE_EVENT, onActivation);
		events.off(PLATFORM_LIFECYCLE_RETIRE_EVENT, onRetire);
		if (owner[PLATFORM_LIFECYCLE_SYMBOL] === lifecycle) {
			delete owner[PLATFORM_LIFECYCLE_SYMBOL];
		}
	});
	const retirements = new Set<Promise<void>>();
	events.emit(
		PLATFORM_LIFECYCLE_ACTIVATE_EVENT,
		lifecycle,
		(retirement: Promise<void>) => retirements.add(retirement),
	);
	channel.postMessage({ type: 'activate', generationId });
	if (previous && previous !== lifecycle) {
		const retirement = previous.retire();
		retirements.add(retirement);
		void retirement.catch((error: unknown) => {
			console.error('[coreloom] stale platform teardown failed', error);
		});
	}
	return Promise.all(retirements).then(() => undefined);
}

/* Preparation may inspect durable state but must not create write handles,
	 workers or timers. Only a fully prepared generation may retire the one that
	 is currently serving requests. */
export async function prepareAndActivatePlatformRuntimeLifecycle(
	lifecycle: PlatformRuntimeLifecycle,
	preparations: readonly (() => void | Promise<void>)[],
): Promise<void> {
	for (const prepare of preparations) await prepare();
	await activatePlatformRuntimeLifecycle(lifecycle);
}

export function activePlatformRuntimeLifecycle():
	| PlatformRuntimeLifecycle
	| undefined {
	return (process as ProcessWithLifecycle)[PLATFORM_LIFECYCLE_SYMBOL];
}
