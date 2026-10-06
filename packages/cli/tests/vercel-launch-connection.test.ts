import type { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { defaultVercelHost } from '../src/vercel-launch.ts';

const opened = vi.hoisted(() => [] as EventEmitter[]);

/* A node-postgres client is an event emitter that reports a dropped connection
   as an `error` event; this one never reaches a network. */
vi.mock('pg', async () => {
	const { EventEmitter } = await import('node:events');
	class OfflineClient extends EventEmitter {
		constructor() {
			super();
			opened.push(this);
		}
		async connect(): Promise<void> {}
		async query(): Promise<{ rows: never[] }> {
			return { rows: [] };
		}
		async end(): Promise<void> {}
	}
	return { Client: OfflineClient };
});

it('keeps a dropped owner connection from ending the launcher process', async () => {
	const session = await defaultVercelHost().openDatabase(
		new URL('postgresql://owner:secret@db.example/neondb'),
	);
	expect(opened).toHaveLength(1);
	expect(() =>
		opened[0]!.emit('error', new Error('Connection terminated unexpectedly')),
	).not.toThrow();
	await session.close();
});
