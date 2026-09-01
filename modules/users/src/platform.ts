import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@coreloom/module-auth/server';
import { createUserRoutes } from './api/endpoints.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	return { routes: createUserRoutes(context.auth) };
}
