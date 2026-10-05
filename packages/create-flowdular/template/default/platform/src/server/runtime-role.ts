import type { ModuleServerComposition } from '@flowdular/sdk/server';

/* combined serves HTTP and runs every module worker in one process. web serves
   HTTP only: its compositions start, but no module worker loop, poller or
   wake-driven claim runs there, so a host that freezes idle instances never
   strands work. The one loop a web process still runs is auth.core's expired
   session sweep (auth.core.sessions), which starts with the auth service in
   every role; freezing it only delays deleting rows every lookup ignores. */
export type PlatformRuntimeRole = 'combined' | 'web';

export function platformRuntimeRole(
	environment: NodeJS.ProcessEnv,
): PlatformRuntimeRole {
	const role = environment.FD_RUNTIME_ROLE?.trim() || 'combined';
	if (role !== 'combined' && role !== 'web') {
		throw new Error('FD_RUNTIME_ROLE must be "combined" or "web".');
	}
	return role;
}

/* Awaited in composition order, so a failed worker start fails the boot before
   the process reports itself ready. */
export async function startModuleWorkers(
	compositions: readonly ModuleServerComposition[],
	role: PlatformRuntimeRole,
): Promise<void> {
	if (role === 'web') return;
	for (const composition of compositions) await composition.startWorker?.();
}
