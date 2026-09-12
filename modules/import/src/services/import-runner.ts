import { IMPORT_LIMITS } from '../domain/types.ts';
import type { ImportService } from './import-service.ts';
import type { ImportRepository } from './repository.ts';

export interface ImportRunnerOptions {
	readonly repository: ImportRepository;
	readonly service: () => Promise<ImportService>;
	/** A claim older than this belonged to a process that is gone. */
	readonly claimTimeoutMs?: number;
	readonly now?: () => number;
}

export interface ImportPassReport {
	readonly examined: number;
	readonly performed: number;
}

/** Ten minutes: longer than the largest job, shorter than an operator's patience. */
const DEFAULT_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * One pass of the job poll. The routing read crosses workspaces on the
 * background role and answers routing columns alone; every job it names is
 * claimed and processed again under the workspace that row named.
 */
export class ImportRunner {
	readonly #repository: ImportRepository;
	readonly #service: () => Promise<ImportService>;
	readonly #claimTimeoutMs: number;
	readonly #now: () => number;

	constructor(options: ImportRunnerOptions) {
		this.#repository = options.repository;
		this.#service = options.service;
		this.#claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
		this.#now = options.now ?? (() => Date.now());
	}

	async tick(limit = IMPORT_LIMITS.routingPage): Promise<ImportPassReport> {
		const pending = await this.#repository.listPendingJobs(limit);
		let performed = 0;
		for (const routing of pending) {
			const now = this.#now();
			const claimed = await this.#repository.claimJob({
				tenantId: routing.tenantId,
				id: routing.id,
				claimedAt: now,
				staleBefore: now - this.#claimTimeoutMs,
			});
			/* Another process holds it, or it left the queue between the routing
			   read and the claim. Either way it is not this pass's work. */
			if (!claimed) continue;
			await (await this.#service()).perform(claimed);
			performed += 1;
		}
		return { examined: pending.length, performed };
	}
}
