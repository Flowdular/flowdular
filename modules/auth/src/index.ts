import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import {
	AUTH_SCOPES,
	BUNDLED_MODULE_SCOPES,
	PLATFORM_SCOPES,
} from './acl/scopes.ts';

export const authModule = {
	manifest: manifest as ModuleManifest,
	navigation: [],
	permissions: [
		...Object.values(AUTH_SCOPES),
		...Object.values(PLATFORM_SCOPES),
		...Object.values(BUNDLED_MODULE_SCOPES),
	],
} satisfies RegisteredModule;

export {
	AUTH_SCOPES,
	BUILTIN_ROLES,
	BUNDLED_MODULE_SCOPES,
	MEMBER_SCOPES,
	OWNER_SCOPES,
	PLATFORM_SCOPES,
} from './acl/scopes.ts';
export { AUTH_MODULE_SETTINGS, createAuthModuleSettings } from './settings.ts';
export type { AuthSettings } from './settings.ts';
export type {
	AuditEvent,
	AuditPage,
	AuthActor,
	AuthPrincipal,
	AuthSession,
	AuthTenantAccess,
	CreateRoleInput,
	CreateTenantMemberInput,
	CreateTenantMemberWithoutPasswordInput,
	SessionSummary,
	TenantRole,
	UpdateRoleInput,
} from './domain/types.ts';
export type {
	ExternalIdentityBinding,
	ExternalIdentityPage,
	TenantMember,
	TenantMemberPage,
	TenantSummary,
} from './services/repository.ts';
