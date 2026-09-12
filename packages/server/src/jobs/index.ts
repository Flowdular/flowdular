/**
 * The durable job loop, extracted from the copies that converged during
 * RFC 0002 (`docs/rfc/0004-platform-services.md`, H2).
 *
 * What the runner owns: the timer and its `unref`, the `inFlight` guard, the
 * bound on claims per pass, the bound on items performed at once and the
 * serialized claim behind it, per-item isolation, the heartbeat timer and the
 * abort it raises when the fence answers false, exponential backoff after a
 * pass that raised, the drain on stop and the trace hook.
 *
 * What a producer gets: `wake()`, one coalesced pass that can see the work it
 * just enqueued. `tick()` joins the pass in flight, and that pass may already
 * have found the queue empty, so a producer that has to be picked up before the
 * next interval wakes the loop rather than ticking it.
 *
 * What the trace hook carries: the passes that claimed something. A pass that
 * claimed nothing emits no `pass-start` and no `pass-end`, so a loop idling
 * against an empty queue costs the span ring nothing.
 *
 * What a module keeps, always: its table, its migration, its routing read, its
 * claim statement and stale window, its renewal statement, the work itself and
 * every outcome it records. The runner opens no database handle.
 *
 * Adopting it, one module at a time behind that module's existing tests:
 *
 * 1. Move the loop body into `claim` (one attempt, null when nothing can be
 *    taken) and `perform` (one claimed item). A module whose routing read
 *    answers a page keeps the page in a closure and refills it only once it is
 *    drained, so one pass still reads the queue once.
 * 2. Pass `staleAfterMs` as the same constant the claim statement subtracts for
 *    its stale cutoff, and `heartbeat` as the fenced renewal. Without a
 *    `heartbeat` the claim is held by wall clock alone, as it is today.
 * 3. Replace the runtime's `setInterval`, `inFlight`, `stop` and `quiesce` with
 *    the runner's. Keep the runtime's lease acquisition and release.
 *
 * Per module, what stays behind (`docs/rfc/0004-platform-services.md` H2 lists
 * the three claim findings that motivate the move):
 *
 * - `audit.core`: three runners, one per loop (`audit.core.sweep`,
 *   `audit.core.export`, `audit.core.erasure`), because the intervals and the
 *   routing pages differ. It keeps the erasure registry seal, the 24 hour
 *   expiry of an unclaimed request, the `lastSweptAt` compare and swap, the
 *   legal-hold and backup guards, and the archive and certificate writing. The
 *   sweep claims nothing, so its `claim` answers the next due class and its
 *   `heartbeat` is absent. Its export and erasure claims gain the renewal they
 *   never had.
 * - `notifications.core`: one runner. It keeps both queue reads (due and
 *   stranded) behind one `claim`, the per-attempt delivery backoff and dead
 *   lettering, the paused-subscription park, and the retention sweep, which is
 *   a second runner rather than a tail appended to every delivery pass.
 * - `approvals.core`: one runner with no `heartbeat`: expiry claims nothing and
 *   the status transition is its own fence. Its per-item `try`/`catch` is the
 *   runner's isolation now; the notification fan-out in the transition stays.
 * - `agents.core` action execution: one runner, adopted. `kick()` is
 *   `runner.wake()`, which coalesces into one follow-up pass, so an invocation
 *   enqueued while a pass runs is performed when that pass ends rather than an
 *   interval later, and the `scheduled` flag and the zero-delay timer are gone
 *   either way. It keeps the per-tool
 *   timeout race, caller-signal bridging, consent and live permission
 *   re-checks, the idempotency key and the audit payload threaded through claim
 *   and settle. Its lease renewal is the runner's `heartbeat`, its routing page
 *   is the runner's `concurrency`, and the runner's `CLAIM_LOST` abort is
 *   bridged onto the controller the module already tracks per invocation, so a
 *   cancellation and a lost lease stop the work at the same place.
 * - `auth.core`: one runner for the expired session sweep, which today has no
 *   `inFlight` guard, no `start` and no `stop` at all. It keeps its deliberate
 *   refusal to serialize the error, as an `onEvent` sink rather than the
 *   runner's own logging, and needs a row bound on the delete before adoption.
 * - `automations.core`: one runner with no `heartbeat`: the `nextRunAt` compare
 *   and swap plus the slot idempotency key are its fence. It keeps the
 *   resolution `AbortController` aborted in `quiesce`, and the auto-disable and
 *   audit rows on a failing target.
 *
 * `workflows.core` is not in the first wave: its worker claims one run per
 * drain and checks its lease at every node boundary, which is a per-item
 * contract the runner does not model.
 */
export {
	createJobRunner,
	DEFAULT_JOB_BATCH_LIMIT,
	JOB_CLAIM_LOST,
	JobClaimLostError,
} from './runner.ts';
export type {
	JobBackoff,
	JobEvent,
	JobPassReport,
	JobRunner,
	JobRunnerOptions,
} from './runner.ts';
export { createJobTraceSink, resumeJobTrace } from '../trace/job-sink.ts';
export type { JobTraceSinkOptions } from '../trace/job-sink.ts';
