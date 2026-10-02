/** Build local PostgreSQL URLs after Compose has injected raw passwords. */
export function installDatabaseUrls(environment) {
	const connections = [
		['FD_DATABASE_URL', 'FD_DATABASE_RUNTIME_PASSWORD', 'coreloom_runtime'],
		[
			'FD_DATABASE_MIGRATOR_URL',
			'FD_DATABASE_MIGRATOR_PASSWORD',
			'coreloom_migrator',
		],
		[
			'FD_DATABASE_BACKGROUND_URL',
			'FD_DATABASE_BACKGROUND_PASSWORD',
			'coreloom_background',
		],
	];
	for (const [urlKey, passwordKey, role] of connections) {
		if (!environment[urlKey]?.trim()) {
			const password = environment[passwordKey];
			if (!password)
				throw new Error(
					`${passwordKey} is required for the local PostgreSQL service.`,
				);
			environment[urlKey] =
				`postgresql://${role}:${encodeURIComponent(password)}@postgres:5432/flowdular`;
		}
		delete environment[passwordKey];
	}
}
