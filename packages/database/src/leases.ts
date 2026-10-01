import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from './contracts.ts';

export interface DatabaseLeaseStep {
	readonly request: DatabaseProviderRequest;
	/* Runs with this lease in hand, before the next lease is taken. A module's
	   migrations belong here: they must finish under the migration role, and
	   they must not be followed by a runtime lease if they failed. */
	readonly prepare?: (lease: DatabaseAdapterLease) => Promise<void>;
}

/* Every module CLI command opens a migration, a runtime and sometimes a
   background lease. Each of those acquisitions can fail, and so can the work done
   between them.

   Opening them one at a time and releasing only at the end is how a lease gets
   leaked: a migration that throws leaves the migration lease outstanding, and an
   acquire that throws leaves every earlier one outstanding. The CLI runner
   disposes the provider by waiting for all leases to come back, so a leak does
   not report the error; it makes the command end on an unsettled top-level await
   with no output at all. That is indistinguishable from a hang, and it is why
   every failure path here has to give the leases back.

   This releases in reverse order, which is the order a caller would release
   them, and it never lets a release failure mask the original error. */
export async function acquireLeases(
	databases: DatabaseProvider,
	steps: readonly DatabaseLeaseStep[],
): Promise<readonly DatabaseAdapterLease[]> {
	const acquired: DatabaseAdapterLease[] = [];
	try {
		for (const step of steps) {
			const lease = await databases.acquire(step.request);
			acquired.push(lease);
			await step.prepare?.(lease);
		}
		return acquired;
	} catch (error) {
		for (const lease of acquired.reverse()) {
			await lease.release().catch(() => undefined);
		}
		throw error;
	}
}
