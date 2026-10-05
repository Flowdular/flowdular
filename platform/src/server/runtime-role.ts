import type { ModuleServerComposition } from '@flowdular/server';

/* combined serves HTTP and runs every module worker in one process. web serves
   HTTP only: its compositions start, but no worker loop, poller or wake-driven
   claim runs there, so a host that freezes idle instances never strands work. */
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
