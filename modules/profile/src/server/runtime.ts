import { coreloomLocalDataPath } from '@coreloom/kernel/legacy-local-state';
import { ProfileService } from '../services/profile-service.ts';
import { SqliteProfileRepository } from '../services/sqlite-repository.ts';

export interface ProfileRuntimeOptions {
	readonly databasePath: string;
}

export interface ProfileRuntime {
	service(): ProfileService;
	dispose(): void;
}

export function profileRuntimeOptionsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): ProfileRuntimeOptions {
	return {
		databasePath:
			environment.CL_PROFILE_DATABASE ??
			(environment.NODE_ENV === 'production'
				? '/data/profile.db'
				: environment.NODE_ENV === 'test'
					? ':memory:'
					: coreloomLocalDataPath(workspaceRoot, 'profile.db')),
	};
}

export function createProfileRuntime(
	options: ProfileRuntimeOptions = profileRuntimeOptionsFromEnvironment(),
): ProfileRuntime {
	let service: ProfileService | undefined;
	let repository: SqliteProfileRepository | undefined;
	let disposed = false;
	return {
		service: () => {
			if (disposed) throw new Error('Profile runtime is disposed.');
			repository ??= new SqliteProfileRepository(options.databasePath);
			service ??= new ProfileService(repository);
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
