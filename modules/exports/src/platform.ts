import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	DEFAULT_STORAGE_MAX_OBJECT_BYTES,
	storageConfigFromEnvironment,
} from '@flowdular/storage';
import { EXPORT_LISTS_CAPABILITY, type ExportLists } from './domain/lists.ts';
import { createExportRoutes, createExportsRuntime } from './server/index.ts';
import { exportsDataClass } from './services/data-classes.ts';
import {
	exportMaxBytes,
	exportMaxRows,
	EXPORTS_MODULE_SETTINGS,
} from './settings.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const objectCeiling = storageObjectCeiling(
		context.environment,
		context.workspaceRoot,
	);
	const runtime = createExportsRuntime({
		databases: context.databases,
		storage: context.storage,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		maxRows: () => exportMaxRows(context.settings),
		maxBytes: () => exportMaxBytes(context.settings),
		maxObjectBytes: () => objectCeiling,
	});
	/* Registered while the platform composes, so a module that owns a list can
	   declare its export in its own composition. */
	context.capabilities.register<ExportLists>(EXPORT_LISTS_CAPABILITY, {
		register: (moduleId, exports) => runtime.lists.register(moduleId, exports),
	});
	/* The catalogue is sealed before start hooks run, so what this module holds
	   is declared here rather than on the first request. */
	context.dataClasses.declare([
		exportsDataClass(
			() => runtime.repository(),
			() => runtime.service(),
		),
	]);
	return {
		routes: createExportRoutes(context.auth, runtime),
		settings: EXPORTS_MODULE_SETTINGS,
		start: () => {
			/* Every module has composed by now, so the catalogue is complete and
			   closed: a job can never be started against a list that appears
			   afterwards. */
			runtime.lists.seal();
			runtime.start();
		},
		stop: () => runtime.quiesce(),
		dispose: () => runtime.dispose(),
	};
}

/* The ceiling the storage port enforces, read from the same configuration the
   platform built the port from. A build or a preview composes under a NODE_ENV
   the adapter check refuses; the port itself never reached a running platform
   with that configuration, so the default ceiling is the one it would apply. */
export function storageObjectCeiling(
	environment: NodeJS.ProcessEnv,
	workspaceRoot: string,
): number {
	try {
		return storageConfigFromEnvironment(environment, workspaceRoot)
			.maxObjectBytes;
	} catch {
		return DEFAULT_STORAGE_MAX_OBJECT_BYTES;
	}
}
