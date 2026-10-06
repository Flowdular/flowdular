import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { BroadcastChannel } from 'node:worker_threads';

/* How the platform's development server stops, for the server itself and for
   the launchers that supervise it. The supervisor's SIGKILL must come after
   the server's own deadline, or it cuts the drain of background work that the
   deadline still allows. */

/** Time the development server has to finish open requests, retire the
    runtime and its background work, and close Vite after a stop signal. */
export const PLATFORM_SHUTDOWN_BUDGET_MS = 6_000;

/** Time a supervisor waits after SIGTERM before it sends SIGKILL. */
export const PLATFORM_STOP_ESCALATION_MS = PLATFORM_SHUTDOWN_BUDGET_MS + 2_000;

/* Stops accepting requests. An open browser tab keeps Vite's HMR socket on
   this server, and the HTTP close waits for every socket, so the HMR sockets
   end here rather than in Vite's own close at the end of the shutdown. The
   close ends only the connections idle when it is called; one whose response
   finishes later, such as an event stream the runtime retirement ends, would
   stay open for keep-alive reuse, so it closes as soon as it goes idle. */
export function stopServing(httpServer, server) {
	const closeWhenIdle = ({ server: owner }) => {
		if (owner === httpServer)
			setImmediate(() => httpServer.closeIdleConnections());
	};
	subscribe('http.server.response.finish', closeWhenIdle);
	const httpClose = new Promise((resolveClose, rejectClose) => {
		if (!httpServer.listening) {
			resolveClose();
			return;
		}
		httpServer.close((error) => (error ? rejectClose(error) : resolveClose()));
	}).finally(() => unsubscribe('http.server.response.finish', closeWhenIdle));
	return Promise.all([httpClose, server.ws.close()]).then(() => undefined);
}

/* Every evaluation of octane.config.ts that has not retired yet holds a
   runtime generation. Each answers this event with its retirement, which
   waits for its open requests and then disposes its databases and workers.
   The channel also reaches generations in other threads, which answer
   nothing, so they get a moment before Vite closes. */
export async function retirePlatformRuntimes() {
	const retirements = [];
	process.emit('flowdular:platform-runtime-retire', (retirement) =>
		retirements.push(retirement),
	);
	const channel = new BroadcastChannel('flowdular.platform.runtime-lifecycle');
	channel.postMessage({ type: 'retire-all' });
	try {
		await Promise.all(retirements);
		await new Promise((resolveRetirement) =>
			setTimeout(resolveRetirement, 100),
		);
	} finally {
		channel.close();
	}
}

/* Each stop delivers more than one signal. pnpm forwards what it receives to
   its script, so a SIGTERM to the process group arrives twice, one Ctrl+C
   arrives as two SIGINTs, and a second Ctrl+C as SIGINT plus SIGTERM. Node
   ends the process on a signal nobody listens for, so the listeners stay for
   the rest of the process and every repeat is ignored. A repeat does not force
   an exit either: an operator's second Ctrl+C cannot be told apart from pnpm's
   copy of the first. SIGHUP is a closed terminal and stops the same way. The
   stop is bounded by its own deadline, or by `deadlineMs` when the caller has
   no single promise to bound; Ctrl+\ (SIGQUIT) or SIGKILL ends the process at
   once. */
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
	process.on('SIGHUP', onSignal);
}
