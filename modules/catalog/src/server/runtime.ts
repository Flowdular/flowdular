import { resolve } from 'node:path';
import { CatalogService } from '../services/catalog-service.ts';
import { SqliteCatalogRepository } from '../services/sqlite-repository.ts';

export interface CatalogRuntimeOptions {
	readonly databasePath: string;
}

export interface CatalogRuntime {
	service(): CatalogService;
}

export function catalogRuntimeOptionsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): CatalogRuntimeOptions {
	return {
		databasePath:
			environment.OERP_CATALOG_DATABASE ??
			(environment.NODE_ENV === 'production'
				? '/data/catalog.db'
				: resolve(workspaceRoot, '.octane-erp/catalog.db')),
	};
}

export function createCatalogRuntime(
	options: CatalogRuntimeOptions = catalogRuntimeOptionsFromEnvironment(),
): CatalogRuntime {
	let service: CatalogService | undefined;
	return {
		service: () => {
			service ??= new CatalogService(
				new SqliteCatalogRepository(options.databasePath),
			);
			return service;
		},
	};
}
