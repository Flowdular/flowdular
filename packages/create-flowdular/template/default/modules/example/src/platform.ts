import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/sdk/modules/auth/server';
import { createExampleRoutes, createExampleRuntime } from './server/index.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createExampleRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
	});
	return {
		routes: createExampleRoutes(context.auth, runtime),
		dispose: () => runtime.dispose(),
	};
}
