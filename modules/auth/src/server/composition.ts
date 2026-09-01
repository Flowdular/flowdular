import type { ServerRoute } from '@octanejs/app-core';
import type {
	ModuleSettingsDeclaration,
	ModuleSettingsRuntime,
	PlatformToolRegistry,
} from '@coreloom/kernel';
import type { AuthRuntime } from './runtime.ts';

/* Contract for the generated platform composition: every enabled module with
   a server surface exposes `createServerComposition` from its `/platform`
   entry, and "oerp module sync" wires the enabled ones together so agents
   never edit octane.config.ts by hand. */

export interface PlatformServerContext {
	readonly environment: NodeJS.ProcessEnv;
	readonly workspaceRoot: string;
	readonly auth: AuthRuntime;
	/** Live, tenant-scoped module settings; read at request time, never at boot. */
	readonly settings: ModuleSettingsRuntime;
	/** Tools a module offers to agent runs; agents.core reads it in start(). */
	readonly agentTools: PlatformToolRegistry;
}

export interface PlatformServerComposition {
	readonly routes: readonly ServerRoute[];
	/** Declared settings; the platform registers them after composing. */
	readonly settings?: ModuleSettingsDeclaration;
	/** Runs after every module composed and declared its settings. */
	readonly start?: () => void;
}
