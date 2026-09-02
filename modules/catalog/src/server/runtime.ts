import { coreloomLocalDataPath } from '@coreloom/kernel/legacy-local-state';
import { CatalogService } from '../services/catalog-service.ts';
import { SqliteCatalogRepository } from '../services/sqlite-repository.ts';

export interface CatalogRuntimeOptions {
	readonly databasePath: string;
}

export interface CatalogRuntime {
	service(): CatalogService;
	dispose(): void;
}

export function catalogRuntimeOptionsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): CatalogRuntimeOptions {
	return {
		databasePath:
			environment.CL_CATALOG_DATABASE ??
			(environment.NODE_ENV === 'production'
				? '/data/catalog.db'
				: environment.NODE_ENV === 'test'
					? ':memory:'
					: coreloomLocalDataPath(workspaceRoot, 'catalog.db')),
	};
}

export function createCatalogRuntime(
	options: CatalogRuntimeOptions = catalogRuntimeOptionsFromEnvironment(),
): CatalogRuntime {
	let service: CatalogService | undefined;
	let repository: SqliteCatalogRepository | undefined;
	let disposed = false;
	return {
		service: () => {
			if (disposed) throw new Error('Catalog runtime is disposed.');
			repository ??= new SqliteCatalogRepository(options.databasePath);
			service ??= new CatalogService(repository);
			return service;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			repository?.close();
			repository = undefined;
			service = undefined;
		},
	};
}
