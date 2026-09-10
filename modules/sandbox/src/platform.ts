import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	createSandboxRoutes,
	createSandboxRuntime,
	sandboxSettingsFromEnvironment,
} from './server/index.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createSandboxRuntime({
		...sandboxSettingsFromEnvironment(context.environment),
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
	});
	return {
		routes: createSandboxRoutes(context.auth, runtime),
		dispose: () => runtime.dispose(),
	};
}
