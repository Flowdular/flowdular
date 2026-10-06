import type { Server } from 'node:http';
import type { ViteDevServer } from 'vite';

export const PLATFORM_SHUTDOWN_BUDGET_MS: number;
export const PLATFORM_STOP_ESCALATION_MS: number;
export function stopServing(
	httpServer: Server,
	server: ViteDevServer,
): Promise<void>;
export function retirePlatformRuntimes(): Promise<void>;
export function stopOnSignals(
	stop: () => void,
	options?: { readonly deadlineMs?: number },
): void;
