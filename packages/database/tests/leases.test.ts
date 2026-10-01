import { describe, expect, it, vi } from 'vitest';
import { acquireLeases } from '../src/leases.ts';
import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '../src/contracts.ts';

interface Harness {
	readonly provider: DatabaseProvider;
	readonly released: string[];
	readonly live: () => number;
}

/* A provider stands in for the real one: it counts leases the way dispose does,
   because that count is exactly what turned a leaked lease into silence. */
function harness(options: { readonly failAt?: number } = {}): Harness {
	const released: string[] = [];
	const held = new Set<string>();
	let issued = 0;
	const provider = {
		adapter: 'pglite',
		async acquire(request: DatabaseProviderRequest) {
			issued += 1;
			const name = `${request.namespace}:${request.purpose}`;
			if (issued === options.failAt) {
				throw new Error(`could not acquire ${name}`);
			}
			held.add(name);
			let releasedOnce = false;
			const lease = {
				database: { name },
				async release() {
					if (releasedOnce) return;
					releasedOnce = true;
					held.delete(name);
					released.push(name);
				},
			} as unknown as DatabaseAdapterLease;
			return lease;
		},
		async check() {
			return { adapter: 'pglite', status: 'ready' as const };
		},
		async dispose() {
			if (held.size > 0) {
				throw new Error(`dispose would wait forever: ${[...held].join(', ')}`);
			}
		},
	} as unknown as DatabaseProvider;
	return { provider, released, live: () => held.size };
}

const requirements = { dialectIds: ['postgresql' as never] };

function steps(
	namespace: string,
	prepare?: () => Promise<void>,
): Parameters<typeof acquireLeases>[1] {
	const request = (purpose: 'migration' | 'runtime' | 'background') => ({
		namespace,
		purpose,
		requirements,
	});
	return [
		{
			request: request('migration'),
			...(prepare ? { prepare: async () => prepare() } : {}),
		},
		{ request: request('runtime') },
		{ request: request('background') },
	];
}

/* Every module CLI command opens a migration, a runtime and a background lease.
   A failure between those acquisitions used to leave the earlier ones
   outstanding, and the runner disposes the provider by waiting for every lease to
   come back, so the command ended with no output instead of its error. */
describe('acquireLeases', () => {
	it('hands back every lease when one acquisition fails', async () => {
		const h = harness({ failAt: 3 });
		await expect(
			acquireLeases(h.provider, steps('leaky.core')),
		).rejects.toThrow(/could not acquire leaky.core:background/);
		expect(h.live()).toBe(0);
		/* Reverse order, the order a caller would release them in. */
		expect(h.released).toEqual(['leaky.core:runtime', 'leaky.core:migration']);
		/* The invariant that turned a leak into silence. */
		await expect(h.provider.dispose()).resolves.toBeUndefined();
	});

	it('hands back every lease when the work between them fails', async () => {
		const h = harness();
		await expect(
			acquireLeases(
				h.provider,
				steps('migrating.core', async () => {
					throw new Error('CHECKSUM_MISMATCH');
				}),
			),
		).rejects.toThrow('CHECKSUM_MISMATCH');
		expect(h.live()).toBe(0);
		expect(h.released).toEqual(['migrating.core:migration']);
		await expect(h.provider.dispose()).resolves.toBeUndefined();
	});

	it('keeps the order the caller declared', async () => {
		const h = harness();
		const leases = await acquireLeases(h.provider, steps('ordered.core'));
		expect(
			leases.map(
				(lease) => (lease.database as unknown as { name: string }).name,
			),
		).toEqual([
			'ordered.core:migration',
			'ordered.core:runtime',
			'ordered.core:background',
		]);
	});

	it('runs migrations before the runtime lease is taken', async () => {
		const order: string[] = [];
		const h = harness();
		await acquireLeases(h.provider, [
			{
				request: {
					namespace: 'ordered.core',
					purpose: 'migration',
					requirements,
				},
				prepare: async () => {
					order.push('migrations');
				},
			},
			{
				request: {
					namespace: 'ordered.core',
					purpose: 'runtime',
					requirements,
				},
				prepare: async () => {
					order.push('runtime');
				},
			},
		]);
		expect(order).toEqual(['migrations', 'runtime']);
	});

	it('does not let a failing release mask the original error', async () => {
		const h = harness({ failAt: 2 });
		const provider = {
			...h.provider,
			acquire: async (request: DatabaseProviderRequest) => {
				const lease = await h.provider.acquire(request);
				return {
					...lease,
					release: () => Promise.reject(new Error('release failed')),
				} as DatabaseAdapterLease;
			},
		} as DatabaseProvider;
		await expect(acquireLeases(provider, steps('noisy.core'))).rejects.toThrow(
			'could not acquire',
		);
	});
});
