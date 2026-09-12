import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import { connectorsAgentTools } from './agent/tools.ts';
import { connectorsDataClasses } from './services/data-classes.ts';
import { CONNECTORS_CALLS_CAPABILITY } from './domain/calls.ts';
import { CONNECTORS_DEFINITIONS_CAPABILITY } from './domain/definitions.ts';
import type { ConnectorCallCapability } from './domain/calls.ts';
import {
	createConnectorsRoutes,
	createConnectorsRuntime,
} from './server/index.ts';
import { connectorCallLimits, CONNECTORS_MODULE_SETTINGS } from './settings.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createConnectorsRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		environment: context.environment,
		workspaceRoot: context.workspaceRoot,
		limits: () => connectorCallLimits(context.settings),
	});
	/* Registered while modules compose: a module shipping its own definition
	   resolves this during its own composition, before the first read seals it. */
	context.capabilities.register(
		CONNECTORS_DEFINITIONS_CAPABILITY,
		runtime.definitions,
	);
	context.capabilities.register<ConnectorCallCapability>(
		CONNECTORS_CALLS_CAPABILITY,
		{
			call: async (request) => (await runtime.calls()).call(request),
			consented: async (tenantId, instanceId, caller) =>
				(await runtime.calls()).consented(tenantId, instanceId, caller),
		},
	);
	context.agentTools.register(connectorsAgentTools(runtime));
	/* The sweep and the export run here, on this module's own lease and under
	   its own tenant transaction; the platform only holds the declaration. */
	context.dataClasses.declare(
		connectorsDataClasses(() => runtime.repository()),
	);
	return {
		routes: createConnectorsRoutes(context.auth, runtime),
		settings: CONNECTORS_MODULE_SETTINGS,
		dispose: () => runtime.dispose(),
	};
}
