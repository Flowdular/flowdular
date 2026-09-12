import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import { createAuditRoutes, createAuditRuntime } from './server/index.ts';
import { AUDIT_ERASURE_CAPABILITY } from './services/erasure-port.ts';
import {
	AUDIT_MODULE_SETTINGS,
	auditSweepBatchSize,
	auditSweepIntervalMs,
} from './settings.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createAuditRuntime({
		databases: context.databases,
		/* The sealed platform catalogue, which is also where this module declares
		   its own ledgers. The platform seals it after every composition ran, so
		   the first request reads what every module agreed on. */
		dataClasses: context.dataClasses,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		environment: context.environment,
		workspaceRoot: context.workspaceRoot,
		sweepIntervalMs: () => auditSweepIntervalMs(context.settings),
		sweepBatchSize: () => auditSweepBatchSize(context.settings),
	});
	/* The adapter for a module that composes after audit.core and prefers to
	   register an erase operation rather than declare it on its data class. The
	   declaration is the port; start() seals this. */
	context.capabilities.register(AUDIT_ERASURE_CAPABILITY, runtime.erasure);
	return {
		routes: createAuditRoutes(context.auth, runtime),
		settings: AUDIT_MODULE_SETTINGS,
		start: () => runtime.start(),
		stop: () => runtime.quiesce(),
		dispose: () => runtime.dispose(),
	};
}
