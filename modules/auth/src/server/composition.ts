import type {
	ModuleServerContext,
	ModuleServerComposition,
} from '@flowdular/server';
import type { AuthRuntime } from './runtime.ts';

/** Compatibility aliases. Generic module composition belongs to the server API. */
export type PlatformServerContext = ModuleServerContext<AuthRuntime>;
export type PlatformServerComposition = ModuleServerComposition;
