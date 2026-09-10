import type {
	ModuleManifest,
	RegisteredModule,
} from '@flowdular/sdk/contracts';
import manifest from '../module.json' with { type: 'json' };
import { CATALOG_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'catalog.navigation',
			label: 'Catalog',
			href: '/catalog',
			order: 20,
			permission: CATALOG_PERMISSIONS.read,
		},
	],
	permissions: Object.values(CATALOG_PERMISSIONS),
} satisfies RegisteredModule;

export { CATALOG_PERMISSIONS } from './acl/permissions.ts';
export {
	CatalogService,
	CatalogServiceError,
} from './services/catalog-service.ts';
export type {
	CatalogItem,
	CatalogItemKind,
	CreateCatalogItemInput,
} from './domain/types.ts';
