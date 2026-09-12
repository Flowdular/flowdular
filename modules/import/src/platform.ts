import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	DOCUMENTS_ATTACHMENTS_CAPABILITY,
	type DocumentAttachments,
} from '@flowdular/module-documents';
import { IMPORT_PORTS_CAPABILITY, type ImportPorts } from './domain/ports.ts';
import { createImportRoutes, createImportRuntime } from './server/index.ts';
import { importDataClass } from './services/data-classes.ts';
import {
	importBatchSize,
	importMaxRows,
	IMPORT_MODULE_SETTINGS,
} from './settings.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createImportRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		/* documents.core is a required dependency and composes first, but the
		   capability is still resolved per call so a deployment that left it out
		   fails the one import that needs it rather than the whole composition. */
		attachments: () =>
			context.capabilities.get<DocumentAttachments>(
				DOCUMENTS_ATTACHMENTS_CAPABILITY,
			),
		maxRows: () => importMaxRows(context.settings),
		batchSize: () => importBatchSize(context.settings),
	});
	/* Registered while the platform composes, so a module that owns records can
	   declare its targets in its own composition. */
	context.capabilities.register<ImportPorts>(IMPORT_PORTS_CAPABILITY, {
		register: (moduleId, ports) => runtime.ports.register(moduleId, ports),
	});
	/* The catalogue is sealed before start hooks run, so what this module holds
	   is declared here rather than on the first request. */
	context.dataClasses.declare([importDataClass(() => runtime.repository())]);
	return {
		routes: createImportRoutes(context.auth, runtime),
		settings: IMPORT_MODULE_SETTINGS,
		start: () => {
			/* Every module has composed by now, so the target list is complete and
			   closed: a job can never be started against a target that appears
			   afterwards. */
			runtime.ports.seal();
			runtime.start();
		},
		stop: () => runtime.quiesce(),
		dispose: () => runtime.dispose(),
	};
}
