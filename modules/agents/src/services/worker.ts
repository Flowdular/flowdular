import type { AgentHarness, AgentProvider } from '@flowdular/harness';
import type {
	AgentRun,
	AgentRunExecution,
	AgentWorkerStatus,
} from '../domain/types.ts';
import type { AgentRepository, RecoverableRun } from './repository.ts';
import {
	publishRunOutcome,
	runNotificationRecipients,
	type NotificationPublisherResolver,
} from './notifications.ts';
import { AGENT_METERS, type MeterRegistryResolver } from './metering.ts';
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
	/* Resolved when a run settles. Absent, or resolving to null, means the
	   optional notifications module is not composed and nothing is published. */
	readonly notifications?: NotificationPublisherResolver;
	/* Resolved when a run settles, so the registry is the one the platform holds
	   then. Absent only in a process that built a worker outside the module
	   composition, such as a test; a composed deployment always has it. */
	readonly meters?: MeterRegistryResolver;
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
	): void | Promise<void>;
}

const CANCELLED = 'cancelled';
const SHUTDOWN = 'worker-shutdown';
const LEASE_LOST = 'lease-lost';

/* A provider, a driver or the database can put any text on `code`. Only a
   stable code may reach the failure record, the audit metadata and the
   notification body a person reads. */
const STABLE_CODE = /^[A-Z][A-Z0-9_]+$/;

function failure(error: unknown): { code: string; message: string } {
	if (error instanceof Error) {
		const code =
			'code' in error &&
			typeof error.code === 'string' &&
			STABLE_CODE.test(error.code)
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
	readonly #idleWaiters = new Set<() => void>();
	readonly #now: () => number;
	#concurrency: number;
	#scheduled = false;
	#draining: Promise<void> | undefined;
	#stopped = true;
	#lastDrainAt: number | null = null;
	#poll: ReturnType<typeof setInterval> | undefined;
	#kickTimer: ReturnType<typeof setTimeout> | undefined;

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

	async start(): Promise<void> {
		this.#stopped = false;
		await this.kick();
		if (this.#stopped || this.#poll !== undefined) return;
		/* Interrupted runs become claimable only once their lease expires, so a
		   periodic drain is what makes recovery happen without a new request. */
		this.#poll = setInterval(
			() => void this.kick(),
			Math.max(1_000, Math.floor(this.options.leaseMs / 2)),
		);
		this.#poll.unref?.();
	}

	stop(): void {
		this.#stopped = true;
		if (this.#poll !== undefined) clearInterval(this.#poll);
		this.#poll = undefined;
		if (this.#kickTimer !== undefined) clearTimeout(this.#kickTimer);
		this.#kickTimer = undefined;
		this.#scheduled = false;
	}

	/* Terminal worker teardown. In-flight provider calls are aborted but their
	   persisted rows stay leased for recovery by the next worker generation. */
	async dispose(): Promise<void> {
		this.stop();
		await this.#draining;
		for (const controller of this.#inFlight.values()) {
			controller.abort(SHUTDOWN);
		}
		if (this.#inFlight.size === 0) return;
		await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
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

	async kick(): Promise<void> {
		if (this.#scheduled || this.#draining || this.#stopped) return;
		this.#scheduled = true;
		this.#kickTimer = setTimeout(async () => {
			this.#kickTimer = undefined;
			this.#scheduled = false;
			try {
				this.#draining = this.#drain();
				await this.#draining;
			} catch (error) {
				/* A failed transactional claim leaves the run recoverable. The
				   periodic poll retries it without crashing the host process. */
				console.error(
					'[agents] run worker drain failed:',
					error instanceof Error ? error.message : error,
				);
			} finally {
				this.#draining = undefined;
			}
		}, 0);
	}

	#currentConcurrency(): number {
		if (typeof this.options.concurrency === 'function') {
			const value = this.options.concurrency();
			if (validConcurrency(value)) this.#concurrency = value;
		}
		return this.#concurrency;
	}

	async #drain(): Promise<void> {
		if (this.#stopped) return;
		this.#lastDrainAt = this.#now();
		const slots = this.#currentConcurrency() - this.#inFlight.size;
		if (slots <= 0) return;
		const candidates = await this.repository.listRecoverableRuns(
			this.#now(),
			slots * 2,
		);
		let claimed = 0;
		for (const candidate of candidates) {
			if (this.#stopped) return;
			if (claimed >= slots || this.#inFlight.has(candidate.runId)) continue;
			const now = this.#now();
			const execution = await this.repository.claimRun(
				candidate.tenantId,
				candidate.runId,
				this.options.workerId,
				now,
				now + this.options.leaseMs,
				{
					tenantId: candidate.tenantId,
					actorId: this.options.workerId,
					action: 'agent-run.claimed',
					subjectType: 'agent-run',
					subjectId: candidate.runId,
					metadata: {},
					occurredAt: now,
				},
			);
			if (this.#stopped) return;
			if (!execution) continue;
			claimed += 1;
			const controller = new AbortController();
			this.#inFlight.set(candidate.runId, controller);
			void this.#execute(candidate, execution, controller)
				.catch((error: unknown) => {
					console.error(
						`[agents] worker failed to settle run ${candidate.runId}:`,
						error instanceof Error ? error.message : error,
					);
				})
				.finally(() => {
					this.#inFlight.delete(candidate.runId);
					if (this.#inFlight.size === 0) {
						for (const resolve of this.#idleWaiters) resolve();
						this.#idleWaiters.clear();
					}
					void this.kick();
				});
		}
	}

	async #execute(
		candidate: RecoverableRun,
		execution: AgentRunExecution,
		controller: AbortController,
	): Promise<void> {
		let eventWrites = Promise.resolve();
		let eventFailure: unknown;
		const renewal = setInterval(
			async () => {
				try {
					const renewed = await this.repository.renewLease(
						candidate.tenantId,
						candidate.runId,
						this.options.workerId,
						this.#now() + this.options.leaseMs,
					);
					if (!renewed) controller.abort(LEASE_LOST);
				} catch {
					/* A database error means ownership cannot be proven. Stop local work
					   and leave the durable row for lease-based recovery. */
					controller.abort(LEASE_LOST);
				}
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
				await this.repository.appendAuditEvent({
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
			): void => {
				// The harness callback is synchronous. Own and drain its async writes.
				eventWrites = eventWrites.then(() =>
					this.repository.appendRunEvent(
						candidate.tenantId,
						candidate.runId,
						event,
					),
				);
				void eventWrites.catch(async (error) => {
					/* An event refused on a run this worker no longer holds is the lost
					   lease, not a persistence fault: an erasure or another worker took
					   the row, and which failure surfaces first is a matter of timing. */
					let owned = false;
					try {
						owned = await this.repository.renewLease(
							candidate.tenantId,
							candidate.runId,
							this.options.workerId,
							this.#now() + this.options.leaseMs,
						);
					} catch {
						owned = false;
					}
					if (!owned) {
						controller.abort(LEASE_LOST);
						return;
					}
					eventFailure = error;
					controller.abort('event-persistence-failed');
				});
			};
			const result = await this.harness.execute(
				{
					runId: execution.run.id,
					tenantId: execution.run.tenantId,
					requestedBy: execution.run.requestedBy,
					requestedActor: execution.run.requestedActor,
					...(execution.run.authorizationSubject
						? { authorizationSubject: execution.run.authorizationSubject }
						: {}),
					trigger: execution.run.trigger,
					input: execution.run.input,
					definition: execution.definition,
					permissionSnapshot: execution.run.permissionSnapshot,
					toolGrants: execution.run.toolGrants,
					outputContract: execution.run.outputContract,
				},
				provider
					? { onEvent, provider, signal: controller.signal }
					: { onEvent, signal: controller.signal },
			);
			await eventWrites;
			await this.repository.completeRun(
				candidate.tenantId,
				candidate.runId,
				this.options.workerId,
				result,
				{
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
				},
			);
			await this.#reportMeters(execution.run, result.usage.totalTokens);
			await this.#recordRunSuccess(
				execution,
				result.completedAt,
				result.startedAt,
			);
			await this.#publishOutcome(execution.run, 'agent-run-completed', {
				title: `Agent ${execution.run.agentName} finished`,
				body: `The run finished in ${result.completedAt - result.startedAt} ms and used ${result.usage.totalTokens} tokens.`,
			});
		} catch (error) {
			await eventWrites.catch(() => undefined);
			/* The service already moved a cancelled row and wrote its audit event;
			   the worker only had to stop. */
			if (controller.signal.aborted && controller.signal.reason === CANCELLED) {
				return;
			}
			if (controller.signal.aborted && controller.signal.reason === SHUTDOWN) {
				return;
			}
			if (
				controller.signal.aborted &&
				controller.signal.reason === LEASE_LOST
			) {
				return;
			}
			const failed =
				eventFailure !== undefined
					? failure(eventFailure)
					: controller.signal.aborted
						? {
								code: 'AGENT_LEASE_LOST',
								message: 'The worker lost its lease on the run.',
							}
						: failure(error);
			const completedAt = this.#now();
			/* A lost lease means another worker owns the row now; the failure
			   record belongs to it, so a rejected write here is not an error. */
			try {
				await this.repository.failRun(
					candidate.tenantId,
					candidate.runId,
					this.options.workerId,
					failed.code,
					failed.message,
					completedAt,
					{
						tenantId: candidate.tenantId,
						actorId: this.options.workerId,
						action: 'agent-run.failed',
						subjectType: 'agent-run',
						subjectId: candidate.runId,
						metadata: { code: failed.code },
						occurredAt: completedAt,
					},
				);
			} catch (settleError) {
				console.error(
					`[agents] run ${candidate.runId} failed with ${failed.code} and could not be settled:`,
					settleError instanceof Error ? settleError.message : settleError,
				);
				return;
			}
			await this.#reportMeters(execution.run, 0);
			await this.#publishOutcome(execution.run, 'agent-run-failed', {
				title: `Agent ${execution.run.agentName} failed`,
				body: `The run stopped with ${failed.code}.`,
			});
		} finally {
			clearInterval(renewal);
			await eventWrites.catch(() => undefined);
		}
	}

	/* Called after the terminal row is committed and outside its transaction.
	   The run id is the source reference, so a terminal step that runs twice
	   reports the same outcome instead of adding a second notification. A run a
	   workflow owns stays silent: workflows.core reports the outcome the person
	   actually asked for, once, instead of one notification per agent step. */
	async #publishOutcome(
		run: AgentRun,
		kind: 'agent-run-completed' | 'agent-run-failed',
		copy: { readonly title: string; readonly body: string },
	): Promise<void> {
		if (run.workflowRunId !== null) return;
		await publishRunOutcome(this.options.notifications, {
			tenantId: run.tenantId,
			kind,
			sourceModule: 'agents.core',
			sourceRef: run.id,
			title: copy.title,
			body: copy.body,
			recipients: runNotificationRecipients(run.authorizationSubject),
		});
	}

	/* Called after the terminal row is committed and outside its transaction.
	   The run id is the source reference, so a terminal step that runs twice
	   counts the run once. Counting is advisory: metering.core commits the fact
	   in its own transaction and a failure there never changes a settled run. A
	   run that reported no tokens counts none rather than claiming zero. */
	async #reportMeters(run: AgentRun, totalTokens: number): Promise<void> {
		const meters = this.options.meters?.();
		if (!meters) return;
		try {
			await meters.record({
				tenantId: run.tenantId,
				meter: AGENT_METERS.runs,
				amount: 1,
				sourceRef: run.id,
			});
			if (totalTokens > 0) {
				await meters.record({
					tenantId: run.tenantId,
					meter: AGENT_METERS.runTokens,
					amount: totalTokens,
					sourceRef: run.id,
				});
			}
		} catch (error) {
			console.warn(
				`[agents] metering for run ${run.id} failed:`,
				error instanceof Error ? error.message : error,
			);
		}
	}

	async #recordRunSuccess(
		execution: AgentRunExecution,
		completedAt: number,
		startedAt: number,
	): Promise<void> {
		try {
			await this.providerResolver?.recordRunSuccess?.(
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
