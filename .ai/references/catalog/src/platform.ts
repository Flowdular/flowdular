import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/sdk/modules/auth/server';
import {
	EXPORT_LISTS_CAPABILITY,
	type ExportLists,
} from '@flowdular/sdk/modules/exports';
import { platformVariableRegistry } from '@flowdular/sdk/kernel';
import { registerCatalogVariableSource } from './domain/variables.ts';
import { catalogDataClasses } from './services/data-classes.ts';
import { createCatalogItemsListExport } from './services/item-export.ts';
import {
	catalogAgentTools,
	createCatalogRoutes,
	createCatalogRuntime,
} from './server/index.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createCatalogRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
	});
	const tools = catalogAgentTools(runtime);
	context.agentTools.register(tools);
	registerCatalogVariableSource(
		platformVariableRegistry(context.capabilities),
		tools,
	);
	context.dataClasses.declare(catalogDataClasses(() => runtime.service()));
	/* exports.core is an optional requirement, so its registry may not exist
	   yet while this module composes; it is asked for here and again at start,
	   and a deployment without exports.core registers nothing. */
	let registered = false;
	const registerLists = (): void => {
		if (registered) return;
		const lists = context.capabilities.get<ExportLists>(
			EXPORT_LISTS_CAPABILITY,
		);
		if (!lists) return;
		registered = true;
		lists.register('catalog.core', [createCatalogItemsListExport(runtime)]);
	};
	registerLists();
	return {
		routes: createCatalogRoutes(context.auth, runtime),
		start: () => registerLists(),
		dispose: () => runtime.dispose(),
	};
}
