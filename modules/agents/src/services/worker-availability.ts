import type { AgentWorkerStatus } from '../domain/types.ts';
import type { AgentRepository } from './repository.ts';

export const DEFAULT_WORKER_FRESHNESS_MS = 120_000;
/* Heartbeats older than this are removed, except the newest, which is what
   an offline answer names. */
export const WORKER_HEARTBEAT_RETENTION_MS = 86_400_000;

/* The periodic drain that recovers expired leases and records a heartbeat. */
export function workerDrainIntervalMs(leaseMs: number): number {
	return Math.max(1_000, Math.floor(leaseMs / 2));
}

/* Never shorter than two drains, or a worker between drains reads offline. */
export function workerFreshnessWindowMs(
	freshnessMs: number,
	leaseMs: number,
): number {
	return Math.max(freshnessMs, 2 * workerDrainIntervalMs(leaseMs));
}

export async function readWorkerStatus(
	repository: Pick<AgentRepository, 'workerHeartbeats' | 'countRunningRuns'>,
	tenantId: string,
	options: {
		readonly now: number;
		readonly leaseMs: number;
		readonly freshnessMs: number;
	},
): Promise<AgentWorkerStatus> {
	const heartbeats = await repository.workerHeartbeats(
		options.now - workerFreshnessWindowMs(options.freshnessMs, options.leaseMs),
	);
	const state =
		heartbeats.fresh > 0
			? 'online'
			: heartbeats.newestAt === null
				? 'not-seen'
				: 'offline';
	return {
		state,
		online: state === 'online',
		concurrency: state === 'online' ? heartbeats.concurrency : 0,
		inFlight: await repository.countRunningRuns(tenantId),
		leaseMs: options.leaseMs,
		lastHeartbeatAt: heartbeats.newestAt,
	};
}
