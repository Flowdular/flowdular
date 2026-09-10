import { resolve } from 'node:path';

/* Session metadata and operator-owned attachment snapshots share one queue.
   Failed work releases the next caller and idle sessions retain no lock. */
const pending = new Map<string, Promise<void>>();

export async function withSessionLock<T>(
	workspaceRoot: string,
	sessionId: string,
	work: () => Promise<T>,
): Promise<T> {
	const key = `${resolve(workspaceRoot)}\0${sessionId}`;
	const previous = pending.get(key);
	let release!: () => void;
	const current = new Promise<void>((done) => {
		release = done;
	});
	pending.set(key, current);
	await previous;
	try {
		return await work();
	} finally {
		release();
		if (pending.get(key) === current) pending.delete(key);
	}
}
