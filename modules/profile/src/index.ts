import type { ModuleManifest, RegisteredModule } from '@coreloom/contracts';
import manifest from '../module.json' with { type: 'json' };
import { PROFILE_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [],
	permissions: Object.values(PROFILE_PERMISSIONS),
} satisfies RegisteredModule;

export { PROFILE_PERMISSIONS } from './acl/permissions.ts';
export {
	ProfileService,
	ProfileServiceError,
} from './services/profile-service.ts';
export type {
	Profile,
	ProfileLanguagePreference,
	UpdateProfileInput,
	UpdateProfileLanguageInput,
} from './domain/types.ts';
