/**
 * Waits for a session to report that it is no longer running.
 *
 * A turn stops when its driver and its gates have both let go, which is work
 * with no fixed duration. Polling against a short wall clock made these tests
 * fail whenever the machine was busy, so the bound here is only a safety net:
 * it exists so a genuine hang reports as a failure instead of running until the
 * suite timeout, and it is deliberately far longer than any real stop.
 */
export async function settledSession(
	running: () => Promise<boolean>,
	boundMs = 25_000,
): Promise<void> {
	const deadline = Date.now() + boundMs;
	while (await running()) {
		if (Date.now() >= deadline) {
			throw new Error(
				`The session still reported itself running ${boundMs}ms after it was stopped.`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
