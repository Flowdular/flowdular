import type { ModuleManifest, RegisteredModule } from '@coreloom/contracts';
import manifest from '../module.json' with { type: 'json' };
import { PARTY_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'parties.navigation.customers',
			label: 'Customers',
			href: '/customers',
			order: 10,
			permission: PARTY_PERMISSIONS.read,
		},
		{
			id: 'parties.navigation.suppliers',
			label: 'Suppliers',
			href: '/suppliers',
			order: 15,
			permission: PARTY_PERMISSIONS.read,
		},
	],
	permissions: Object.values(PARTY_PERMISSIONS),
} satisfies RegisteredModule;

export { PARTY_PERMISSIONS } from './acl/permissions.ts';
export {
	PartiesService,
	PartyServiceError,
} from './services/parties-service.ts';
export type {
	CreatePartyInput,
	Party,
	PartyKind,
	UpdatePartyInput,
} from './domain/types.ts';
