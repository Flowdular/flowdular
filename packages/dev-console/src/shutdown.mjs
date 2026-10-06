/* Each stop delivers more than one signal. pnpm forwards what it receives to
   its script, so a SIGTERM to the process group arrives twice, one Ctrl+C
   arrives as two SIGINTs, and a second Ctrl+C as SIGINT plus SIGTERM. Node
   ends the process on a signal nobody listens for, so the listeners stay for
   the rest of the process and every repeat is ignored. A repeat does not force
   an exit either: an operator's second Ctrl+C cannot be told apart from pnpm's
   copy of the first. The stop is bounded by its own deadline; Ctrl+\ (SIGQUIT)
   or SIGKILL ends the process at once. */
export function stopOnSignals(stop) {
	let stopping = false;
	const onSignal = () => {
		if (stopping) return;
		stopping = true;
		stop();
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
}
