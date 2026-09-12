import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import { createSystemRoutes } from './server/endpoints.ts';
import { SYSTEM_MODULE_SETTINGS } from './settings.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	return {
		routes: createSystemRoutes(context),
		settings: SYSTEM_MODULE_SETTINGS,
	};
}
