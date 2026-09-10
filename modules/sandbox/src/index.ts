import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { SANDBOX_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'sandbox.navigation',
			label: 'Sandbox',
			href: '/sandbox',
			order: 70,
			permission: SANDBOX_PERMISSIONS.manage,
		},
	],
	permissions: Object.values(SANDBOX_PERMISSIONS),
} satisfies RegisteredModule;

export {
	SANDBOX_GRANT_CAPABILITIES,
	SANDBOX_PERMISSIONS,
} from './acl/permissions.ts';
export type {
	SandboxAccessCandidate,
	SandboxAccessGrant,
	SandboxAuditEvent,
	SandboxAuthority,
	SandboxAuthorityDenial,
	SandboxGrantCapability,
	SandboxRuntimeMode,
	SandboxSessionRecord,
	SandboxSessionState,
} from './domain/types.ts';
