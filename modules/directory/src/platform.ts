import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	authPortFromRuntime,
	createDirectoryRoutes,
	createDirectoryRuntime,
	createScimRoutes,
} from './server/index.ts';
import { directoryDataClasses } from './services/data-classes.ts';
import { DIRECTORY_MODULE_SETTINGS } from './settings.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const auth = authPortFromRuntime(context.auth);
	const runtime = createDirectoryRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		auth,
	});
	/* The sweep and the export run here, on this module's own leases and under
	   its own tenant transaction; the platform only holds the declaration. */
	context.dataClasses.declare(
		directoryDataClasses(() => runtime.administration()),
	);
	return {
		routes: [
			...createDirectoryRoutes(context.auth, runtime, context.settings),
			...createScimRoutes(auth, runtime, context.settings, {
				trustProxy: context.auth.trustProxy,
			}),
		],
		settings: DIRECTORY_MODULE_SETTINGS,
		dispose: () => runtime.dispose(),
	};
}
