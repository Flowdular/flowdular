import type { ModuleManifest, RegisteredModule } from '@coreloom/contracts';
import manifest from '../module.json' with { type: 'json' };
import { SYSTEM_PERMISSIONS } from './acl/permissions.ts';

export const systemModule = {
	manifest: manifest as ModuleManifest,
	navigation: [],
	permissions: Object.values(SYSTEM_PERMISSIONS),
} satisfies RegisteredModule;

export { SYSTEM_PERMISSIONS } from './acl/permissions.ts';
