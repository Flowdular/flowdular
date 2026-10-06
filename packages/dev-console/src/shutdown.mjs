/* How the platform's development server stops, for the server itself and for
   the launchers that supervise it. The supervisor's SIGKILL must come after
   the server's own deadline, or it cuts the drain of background work that the
   deadline still allows. */

/** Time the development server has to finish open requests, retire the
    runtime and its background work, and close Vite after a stop signal. */
export const PLATFORM_SHUTDOWN_BUDGET_MS = 6_000;

/** Time a supervisor waits after SIGTERM before it sends SIGKILL. */
export const PLATFORM_STOP_ESCALATION_MS = PLATFORM_SHUTDOWN_BUDGET_MS + 2_000;

/* Each stop delivers more than one signal. pnpm forwards what it receives to
   its script, so a SIGTERM to the process group arrives twice, one Ctrl+C
   arrives as two SIGINTs, and a second Ctrl+C as SIGINT plus SIGTERM. Node
   ends the process on a signal nobody listens for, so the listeners stay for
   the rest of the process and every repeat is ignored. A repeat does not force
   an exit either: an operator's second Ctrl+C cannot be told apart from pnpm's
   copy of the first. The stop is bounded by its own deadline, or by
   `deadlineMs` when the caller has no single promise to bound; Ctrl+\
   (SIGQUIT) or SIGKILL ends the process at once. */
export function stopOnSignals(stop, { deadlineMs } = {}) {
	let stopping = false;
	const onSignal = () => {
		if (stopping) return;
		stopping = true;
		if (deadlineMs !== undefined)
			/* Unref'd, so a stop that drains in time exits on its own. */
			setTimeout(() => {
				console.error(`Development server shutdown exceeded ${deadlineMs} ms.`);
				process.exit(1);
			}, deadlineMs).unref();
		stop();
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
}
