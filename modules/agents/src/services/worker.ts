import type { AgentHarness, AgentProvider } from '@coreloom/harness';
import type { AgentRunExecution, AgentWorkerStatus } from '../domain/types.ts';
import type { AgentRepository, RecoverableRun } from './repository.ts';
import type { AgentProviderBroker } from './provider-broker.ts';
import type { AgentRunGrantAuthority } from './run-grant.ts';

export interface AgentWorkerOptions {
	readonly workerId: string;
	/* A function is read at every drain so an admin change applies without a
	   restart. Out-of-range values fall back to the last valid one. */
	readonly concurrency: number | (() => number);
	readonly leaseMs: number;
	readonly runGrantAuthority?: AgentRunGrantAuthority;
	readonly providerBroker?: AgentProviderBroker;
	readonly now?: () => number;
}

export interface AgentProviderResolver {
	resolve(
		tenantId: string,
		providerId: string,
		modelId: string,
	): Promise<AgentProvider | null>;
	/* A run that answered is fresher evidence than any probe. */
	recordRunSuccess?(
		tenantId: string,
		providerId: string,
		modelId: string,
		completedAt: number,
		durationMs: number,
	): void;
}

const CANCELLED = 'cancelled';

function failure(error: unknown): { code: string; message: string } {
	if (error instanceof Error) {
		const code =
			'code' in error && typeof error.code === 'string'
				? error.code
				: 'AGENT_EXECUTION_FAILED';
		return { code, message: error.message.slice(0, 1_000) };
	}
	return {
		code: 'AGENT_EXECUTION_FAILED',
		message: 'The agent execution failed.',
	};
}

function validConcurrency(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 1 && value <= 16;
}

export class AgentWorker {
	readonly #inFlight = new Map<string, AbortController>();
	readonly #now: () => number;
	#concurrency: number;
	#scheduled = false;
	#stopped = false;
	#lastDrainAt: number | null = null;
	#poll: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly repository: AgentRepository,
		private readonly harness: AgentHarness,
		private readonly options: AgentWorkerOptions,
		private readonly providerResolver?: AgentProviderResolver,
	) {
		const concurrency =
			typeof options.concurrency === 'function'
				? options.concurrency()
				: options.concurrency;
		if (!validConcurrency(concurrency)) {
			throw new Error('Agent worker concurrency must be between 1 and 16.');
		}
		this.#concurrency = concurrency;
		if (
			Boolean(options.runGrantAuthority) !== Boolean(options.providerBroker)
		) {
			throw new Error(
				'Agent worker run grant authority and provider broker must be configured together.',
			);
		}
		if (
			!Number.isSafeInteger(options.leaseMs) ||
			options.leaseMs < 1_000 ||
			options.leaseMs > 300_000
		) {
			throw new Error('Agent worker lease must be between 1000 and 300000 ms.');
		}
		this.#now = options.now ?? Date.now;
	}

	start(): void {
		this.#stopped = false;
		this.kick();
		if (this.#poll !== undefined) return;
		/* Interrupted runs become claimable only once their lease expires, so a
		   periodic drain is what makes recovery happen without a new request. */
		this.#poll = setInterval(
			() => this.kick(),
			Math.max(1_000, Math.floor(this.options.leaseMs / 2)),
		);
		this.#poll.unref?.();
	}

	stop(): void {
		this.#stopped = true;
		if (this.#poll !== undefined) clearInterval(this.#poll);
		this.#poll = undefined;
	}

	/* Online means the periodic drain runs, so queued and interrupted work
	   is picked up without a request. */
	status(): AgentWorkerStatus {
		return {
			workerId: this.options.workerId,
			online: this.#poll !== undefined && !this.#stopped,
			concurrency: this.#currentConcurrency(),
			inFlight: this.#inFlight.size,
			leaseMs: this.options.leaseMs,
			lastDrainAt: this.#lastDrainAt,
		};
	}

	/* Aborts the in-flight execution of a run this process owns. The caller
	   has already moved the row to cancelled; the worker only stops working. */
	cancel(runId: string): boolean {
		const controller = this.#inFlight.get(runId);
		if (!controller) return false;
		controller.abort(CANCELLED);
		return true;
	}

	kick(): void {
		if (this.#scheduled || this.#stopped) return;
		this.#scheduled = true;
		setTimeout(() => {
			this.#scheduled = false;
			this.#drain();
		}, 0);
	}

	#currentConcurrency(): number {
		if (typeof this.options.concurrency === 'function') {
			const value = this.options.concurrency();
			if (validConcurrency(value)) this.#concurrency = value;
		}
		return this.#concurrency;
	}

	#drain(): void {
		if (this.#stopped) return;
		this.#lastDrainAt = this.#now();
		const slots = this.#currentConcurrency() - this.#inFlight.size;
		if (slots <= 0) return;
		const candidates = this.repository.listRecoverableRuns(
			this.#now(),
			slots * 2,
		);
		let claimed = 0;
		for (const candidate of candidates) {
			if (claimed >= slots || this.#inFlight.has(candidate.runId)) continue;
			const now = this.#now();
			const execution = this.repository.claimRun(
				candidate.tenantId,
				candidate.runId,
				this.options.workerId,
				now,
				now + this.options.leaseMs,
			);
			if (!execution) continue;
			claimed += 1;
			const controller = new AbortController();
			this.#inFlight.set(candidate.runId, controller);
			this.repository.appendAuditEvent({
				tenantId: candidate.tenantId,
				actorId: this.options.workerId,
				action: 'agent-run.claimed',
				subjectType: 'agent-run',
				subjectId: candidate.runId,
				metadata: { attempt: execution.run.attempt },
				occurredAt: now,
			});
			void this.#execute(candidate, execution, controller)
				.catch((error: unknown) => {
					console.error(
						`[agents] worker failed to settle run ${candidate.runId}:`,
						error instanceof Error ? error.message : error,
					);
				})
				.finally(() => {
					this.#inFlight.delete(candidate.runId);
					this.kick();
				});
		}
	}

	async #execute(
		candidate: RecoverableRun,
		execution: AgentRunExecution,
		controller: AbortController,
	): Promise<void> {
		const renewal = setInterval(
			() => {
				const renewed = this.repository.renewLease(
					candidate.tenantId,
					candidate.runId,
					this.options.workerId,
					this.#now() + this.options.leaseMs,
				);
				if (!renewed) controller.abort('lease-lost');
			},
			Math.max(500, Math.floor(this.options.leaseMs / 2)),
		);
		try {
			let provider: AgentProvider | null | undefined;
			if (this.options.runGrantAuthority && this.options.providerBroker) {
				if (execution.run.leaseExpiresAt === null) {
					throw new Error('Claimed agent run has no worker lease.');
				}
				const grant = this.options.runGrantAuthority.issue({
					tenantId: candidate.tenantId,
					runId: candidate.runId,
					providerId: execution.run.provider,
					modelId: execution.run.model,
					workerId: this.options.workerId,
					attempt: execution.run.attempt,
					permissions: execution.run.permissionSnapshot,
					toolGrants: execution.run.toolGrants,
					leaseExpiresAt: execution.run.leaseExpiresAt,
				});
				this.repository.appendAuditEvent({
					tenantId: candidate.tenantId,
					actorId: this.options.workerId,
					action: 'agent-run.grant-issued',
					subjectType: 'agent-run',
					subjectId: candidate.runId,
					metadata: {
						grantId: grant.claims.grantId,
						providerId: grant.claims.providerId,
						modelId: grant.claims.modelId,
						expiresAt: grant.claims.expiresAt,
						attempt: grant.claims.attempt,
					},
					occurredAt: grant.claims.issuedAt,
				});
				provider = (await this.options.providerBroker.exchange(grant.token))
					.provider;
			} else {
				provider = await this.providerResolver?.resolve(
					candidate.tenantId,
					execution.run.provider,
					execution.run.model,
				);
			}
			const onEvent = (
				event: Parameters<AgentRepository['appendRunEvent']>[2],
			) =>
				this.repository.appendRunEvent(
					candidate.tenantId,
					candidate.runId,
					event,
				);
			const result = await this.harness.execute(
				{
					runId: execution.run.id,
					tenantId: execution.run.tenantId,
					requestedBy: execution.run.requestedBy,
					trigger: execution.run.trigger,
					input: execution.run.input,
					definition: execution.definition,
					permissionSnapshot: execution.run.permissionSnapshot,
					toolGrants: execution.run.toolGrants,
				},
				provider
					? { onEvent, provider, signal: controller.signal }
					: { onEvent, signal: controller.signal },
			);
			this.repository.completeRun(
				candidate.tenantId,
				candidate.runId,
				this.options.workerId,
				result,
			);
			this.repository.appendAuditEvent({
				tenantId: candidate.tenantId,
				actorId: this.options.workerId,
				action: 'agent-run.succeeded',
				subjectType: 'agent-run',
				subjectId: candidate.runId,
				metadata: {
					durationMs: result.completedAt - result.startedAt,
					totalTokens: result.usage.totalTokens,
				},
				occurredAt: result.completedAt,
			});
			this.#recordRunSuccess(execution, result.completedAt, result.startedAt);
		} catch (error) {
			/* The service already moved a cancelled row and wrote its audit event;
			   the worker only had to stop. */
			if (controller.signal.aborted && controller.signal.reason === CANCELLED) {
				return;
			}
			const failed = controller.signal.aborted
				? {
						code: 'AGENT_LEASE_LOST',
						message: 'The worker lost its lease on the run.',
					}
				: failure(error);
			const completedAt = this.#now();
			/* A lost lease means another worker owns the row now; the failure
			   record belongs to it, so a rejected write here is not an error. */
			try {
				this.repository.failRun(
					candidate.tenantId,
					candidate.runId,
					this.options.workerId,
					failed.code,
					failed.message,
					completedAt,
				);
				this.repository.appendAuditEvent({
					tenantId: candidate.tenantId,
					actorId: this.options.workerId,
					action: 'agent-run.failed',
					subjectType: 'agent-run',
					subjectId: candidate.runId,
					metadata: { code: failed.code },
					occurredAt: completedAt,
				});
			} catch (settleError) {
				console.error(
					`[agents] run ${candidate.runId} failed with ${failed.code} and could not be settled:`,
					settleError instanceof Error ? settleError.message : settleError,
				);
			}
		} finally {
			clearInterval(renewal);
		}
	}

	#recordRunSuccess(
		execution: AgentRunExecution,
		completedAt: number,
		startedAt: number,
	): void {
		try {
			this.providerResolver?.recordRunSuccess?.(
				execution.run.tenantId,
				execution.run.provider,
				execution.run.model,
				completedAt,
				completedAt - startedAt,
			);
		} catch (error) {
			console.error(
				`[agents] readiness refresh after run ${execution.run.id} failed:`,
				error instanceof Error ? error.message : error,
			);
		}
	}
}
