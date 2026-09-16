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
	ClaimedDocumentText,
	DocumentsRepository,
	DocumentTextRouting,
} from './repository.ts';
import type { DocumentTextService } from './text-service.ts';

/* Enqueuing wakes the runner, so the interval only picks up a claim another
   process left behind or a row enqueued on another instance. */
export const DOCUMENT_TEXT_POLL_INTERVAL_MS = 5_000;

/** Longer than a 25 MiB document and a 60 second OCR call take together. */
export const DOCUMENT_TEXT_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

const ROUTING_PAGE = 25;

export interface DocumentTextRunnerOptions {
	readonly repository: () => Promise<DocumentsRepository>;
	readonly service: () => Promise<DocumentTextService>;
	readonly pollIntervalMs?: number | undefined;
	readonly claimTimeoutMs?: number | undefined;
	readonly heartbeatEveryMs?: number | undefined;
	readonly now?: (() => number) | undefined;
	readonly onEvent?: ((event: JobEvent) => void) | undefined;
}

/**
 * The text extraction job as the platform runner sees it. The routing read
 * crosses workspaces on the background role and sees routing columns alone;
 * each claim, renewal and settle runs again under the workspace it names.
 */
export function createDocumentTextRunner(
	options: DocumentTextRunnerOptions,
): JobRunner {
	const staleAfterMs = options.claimTimeoutMs ?? DOCUMENT_TEXT_CLAIM_TIMEOUT_MS;
	const intervalMs = options.pollIntervalMs ?? DOCUMENT_TEXT_POLL_INTERVAL_MS;
	let queue: DocumentTextRouting[] = [];
	let refillable = true;
	let skipped = 0;

	return createJobRunner<ClaimedDocumentText>({
		name: 'documents.core.text',
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
					const page = await repository.listPendingText(ROUTING_PAGE);
					refillable = page.length === ROUTING_PAGE;
					queue = [...page];
					if (queue.length === 0) break;
				}
				const routing = queue.shift()!;
				const claimed = await repository.claimText({
					tenantId: routing.tenantId,
					documentId: routing.documentId,
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
			(await options.repository()).heartbeatText(
				job.tenantId,
				job.documentId,
				job.claimedBy,
				at,
			),
		perform: async (job, signal) => {
			await (await options.service()).perform(job, signal);
			signal.throwIfAborted();
		},
	});
}
