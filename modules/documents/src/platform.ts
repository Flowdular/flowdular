import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	DOCUMENTS_ATTACHMENTS_CAPABILITY,
	type DocumentAttachments,
} from './domain/attachments.ts';
import {
	createDocumentsRoutes,
	createDocumentsRuntime,
} from './server/index.ts';
import { createDocumentAttachments } from './services/attachments.ts';
import { documentsDataClass } from './services/data-classes.ts';
import {
	documentsMaxObjectBytes,
	documentsQuotaBytes,
	documentsReadUrlSeconds,
	DOCUMENTS_MODULE_SETTINGS,
} from './settings.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createDocumentsRuntime({
		databases: context.databases,
		storage: context.storage,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		quotaBytes: (tenantId) => documentsQuotaBytes(context.settings, tenantId),
		readUrlSeconds: () => documentsReadUrlSeconds(context.settings),
	});
	/* Registered while the platform composes, so a module that holds records can
	   resolve it in its own composition before any request runs. */
	context.capabilities.register<DocumentAttachments>(
		DOCUMENTS_ATTACHMENTS_CAPABILITY,
		createDocumentAttachments(() => runtime.service()),
	);
	/* The catalogue is sealed before start hooks run, so what this module holds
	   is declared here rather than on the first request. */
	context.dataClasses.declare([documentsDataClass(() => runtime.service())]);
	return {
		routes: createDocumentsRoutes(context.auth, runtime, {
			maxObjectBytes: documentsMaxObjectBytes(
				context.environment,
				context.workspaceRoot,
			),
		}),
		settings: DOCUMENTS_MODULE_SETTINGS,
		dispose: () => runtime.dispose(),
	};
}
