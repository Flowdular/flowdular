import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { ACCESS_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'access.navigation',
			label: 'Access review',
			href: '/access-review',
			order: 70,
			permission: ACCESS_PERMISSIONS.read,
		},
	],
	permissions: Object.values(ACCESS_PERMISSIONS),
} satisfies RegisteredModule;

export { ACCESS_PERMISSIONS } from './acl/permissions.ts';
export { ACCESS_LIMITS } from './domain/types.ts';
export type {
	AccessAttestation,
	AccessChange,
	AccessChangeCategory,
	AccessChangePage,
	AccessReview,
	AccessReviewCounts,
	AccessReviewMember,
	AccessReviewProvider,
	AccessReviewRole,
	AccessReviewSection,
	AccessReviewToken,
	AccessWindow,
	AttestationPage,
	AttestationPosition,
	AuditPosition,
} from './domain/types.ts';
export { AccessServiceError } from './services/access-service.ts';
