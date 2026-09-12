import type { ServerRoute } from '@octanejs/app-core';
import type { ModuleWebSurface } from '@flowdular/contracts';
import type { DatabaseProvider } from '@flowdular/database';
import type { StoragePort } from '@flowdular/storage';
import type {
	ModuleSettingsDeclaration,
	ModuleSettingsRuntime,
	PlatformAgentRegistry,
	PlatformCapabilityRegistry,
	PlatformDataClassRegistry,
	PlatformToolRegistry,
} from '@flowdular/kernel';

/* Contract for the generated platform composition: every enabled module with
   a server surface exposes `createServerComposition` from its `/platform`
   entry, and "flowdular module sync" wires the enabled ones together so agents
   never edit octane.config.ts by hand. */

export interface ModuleServerContext<Auth> {
	readonly environment: NodeJS.ProcessEnv;
	readonly workspaceRoot: string;
	readonly auth: Auth;
	/** Live, tenant-scoped module settings; read at request time, never at boot. */
	readonly settings: ModuleSettingsRuntime;
	/** Tools a module offers to agent runs; agents.core reads it in start(). */
	readonly agentTools: PlatformToolRegistry;
	/** Business agent definitions modules register before the platform starts. */
	readonly agentDefinitions: PlatformAgentRegistry;
	/**
	 * The data a module owns, declared while it composes. The platform seals
	 * the registry after every composition ran, so `list()` answers the whole
	 * catalogue from any module's view; the binding limits what a module may
	 * declare, never what it may read.
	 */
	readonly dataClasses: PlatformDataClassRegistry;
	/** Typed public services shared by composed modules without database access. */
	readonly capabilities: PlatformCapabilityRegistry;
	/** Platform-owned database leases. Modules never receive a DSN or pool. */
	readonly databases: DatabaseProvider;
	/**
	 * Platform-owned object storage. The tenant id is the first key segment and
	 * comes from the principal, never from the request, because no row-level
	 * security reaches an object store.
	 */
	readonly storage: StoragePort;
}

export interface ModuleServerComposition {
	/** Set by the CLI-generated composition, never inferred from a request. */
	readonly moduleId?: string;
	readonly web?: readonly ModuleWebSurface[];
	readonly routes: readonly ServerRoute[];
	/** Declared settings; the platform registers them after composing. */
	readonly settings?: ModuleSettingsDeclaration;
	/** Read-only validation performed before the healthy generation is retired. */
	readonly prepare?: () => void | Promise<void>;
	/** Runs after every module composed and declared its settings. */
	readonly start?: () => void;
	/** Stops and drains background work before any module resource is disposed. */
	readonly stop?: () => void | Promise<void>;
	/** Releases repositories, workers, timers, and listeners owned by the module. */
	readonly dispose?: () => void | Promise<void>;
}
