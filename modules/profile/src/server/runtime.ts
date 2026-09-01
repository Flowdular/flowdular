import { resolve } from 'node:path';
import { ProfileService } from '../services/profile-service.ts';
import { SqliteProfileRepository } from '../services/sqlite-repository.ts';

export interface ProfileRuntimeOptions {
	readonly databasePath: string;
}

export interface ProfileRuntime {
	service(): ProfileService;
}

export function profileRuntimeOptionsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): ProfileRuntimeOptions {
	return {
		databasePath:
			environment.OERP_PROFILE_DATABASE ??
			(environment.NODE_ENV === 'production'
				? '/data/profile.db'
				: resolve(workspaceRoot, '.octane-erp/profile.db')),
	};
}

export function createProfileRuntime(
	options: ProfileRuntimeOptions = profileRuntimeOptionsFromEnvironment(),
): ProfileRuntime {
	let service: ProfileService | undefined;
	return {
		service: () => {
			service ??= new ProfileService(
				new SqliteProfileRepository(options.databasePath),
			);
			return service;
		},
	};
}
