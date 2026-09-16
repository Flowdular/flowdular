import { randomUUID } from 'node:crypto';
import {
	createJobRunner,
	createJobTraceSink,
	jobBackoff,
	serverLogger,
	type JobEvent,
	type JobRunner,
} from '@flowdular/server';
import type {
	ClaimedRender,
	DocumentTemplatesRepository,
	RenderRouting,
} from './templates-repository.ts';
import {
	DOCUMENT_RENDER_CLAIM_TIMEOUT_MS,
	type DocumentTemplatesService,
} from './templates-service.ts';

/* Queuing a render wakes the runner, so the interval only picks up a claim
   another process left behind or a render queued on another instance. */
export const DOCUMENT_RENDER_POLL_INTERVAL_MS = 5_000;

const ROUTING_PAGE = 25;

export interface DocumentRenderRunnerOptions {
	readonly repository: () => Promise<DocumentTemplatesRepository>;
	readonly service: () => Promise<DocumentTemplatesService>;
	readonly pollIntervalMs?: number | undefined;
	readonly claimTimeoutMs?: number | undefined;
	readonly heartbeatEveryMs?: number | undefined;
	readonly now?: (() => number) | undefined;
	readonly onEvent?: ((event: JobEvent) => void) | undefined;
}

/**
 * The render job as the platform runner sees it. The routing read crosses
 * workspaces on the background role and sees routing columns alone; each
 * claim, renewal and settle runs again under the workspace it names.
 */
export function createDocumentRenderRunner(
	options: DocumentRenderRunnerOptions,
): JobRunner {
	const staleAfterMs =
		options.claimTimeoutMs ?? DOCUMENT_RENDER_CLAIM_TIMEOUT_MS;
	const intervalMs = options.pollIntervalMs ?? DOCUMENT_RENDER_POLL_INTERVAL_MS;
	let queue: RenderRouting[] = [];
	let refillable = true;
	let skipped = 0;

	return createJobRunner<ClaimedRender>({
		name: 'documents.core.render',
		intervalMs,
		staleAfterMs,
		backoff: jobBackoff(intervalMs),
		batchLimit: ROUTING_PAGE,
		heartbeatEveryMs: options.heartbeatEveryMs,
		logger: serverLogger,
		now: options.now,
		onEvent: options.onEvent ?? createJobTraceSink(),
		claim: async (at) => {
			const repository = await options.repository();
			while (skipped < ROUTING_PAGE) {
				if (queue.length === 0) {
					if (!refillable) break;
					const page = await repository.listPendingRenders(
						ROUTING_PAGE,
						at - staleAfterMs,
					);
					refillable = page.length === ROUTING_PAGE;
					queue = [...page];
					if (queue.length === 0) break;
				}
				const routing = queue.shift()!;
				const claimed = await repository.claimRender({
					tenantId: routing.tenantId,
					id: routing.id,
					claimedBy: randomUUID(),
					claimedAt: at,
					staleBefore: at - staleAfterMs,
				});
				if (claimed) return claimed;
				/* Another process holds it, or it settled after the routing read. */
				skipped += 1;
			}
			skipped = 0;
			refillable = true;
			return null;
		},
		heartbeat: async (job, at) =>
			(await options.repository()).heartbeatRender(
				job.tenantId,
				job.id,
				job.claimedBy,
				at,
			),
		perform: async (job, signal) => {
			await (await options.service()).perform(job, signal);
			signal.throwIfAborted();
		},
	});
}
