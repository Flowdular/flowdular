import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import { createSystemRoutes } from './server/endpoints.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	return { routes: createSystemRoutes(context) };
}
