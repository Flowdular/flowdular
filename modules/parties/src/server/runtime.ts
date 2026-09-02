import { coreloomLocalDataPath } from '@coreloom/kernel/legacy-local-state';
import { PartiesService } from '../services/parties-service.ts';
import { SqlitePartyRepository } from '../services/sqlite-repository.ts';

export interface PartiesRuntimeOptions {
	readonly databasePath: string;
}

export interface PartiesRuntime {
	service(): PartiesService;
	dispose(): void;
}

export function partiesRuntimeOptionsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): PartiesRuntimeOptions {
	return {
		databasePath:
			environment.CL_PARTIES_DATABASE ??
			(environment.NODE_ENV === 'production'
				? '/data/parties.db'
				: environment.NODE_ENV === 'test'
					? ':memory:'
					: coreloomLocalDataPath(workspaceRoot, 'parties.db')),
	};
}

export function createPartiesRuntime(
	options: PartiesRuntimeOptions = partiesRuntimeOptionsFromEnvironment(),
): PartiesRuntime {
	let service: PartiesService | undefined;
	let repository: SqlitePartyRepository | undefined;
	let disposed = false;
	return {
		service: () => {
			if (disposed) throw new Error('Parties runtime is disposed.');
			repository ??= new SqlitePartyRepository(options.databasePath);
			service ??= new PartiesService(repository);
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
