import { resolve } from 'node:path';
import { PartiesService } from '../services/parties-service.ts';
import { SqlitePartyRepository } from '../services/sqlite-repository.ts';

export interface PartiesRuntimeOptions {
	readonly databasePath: string;
}

export interface PartiesRuntime {
	service(): PartiesService;
}

export function partiesRuntimeOptionsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): PartiesRuntimeOptions {
	return {
		databasePath:
			environment.OERP_PARTIES_DATABASE ??
			(environment.NODE_ENV === 'production'
				? '/data/parties.db'
				: resolve(workspaceRoot, '.octane-erp/parties.db')),
	};
}

export function createPartiesRuntime(
	options: PartiesRuntimeOptions = partiesRuntimeOptionsFromEnvironment(),
): PartiesRuntime {
	let service: PartiesService | undefined;
	return {
		service: () => {
			service ??= new PartiesService(
				new SqlitePartyRepository(options.databasePath),
			);
			return service;
		},
	};
}
