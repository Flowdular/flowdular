import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	createWorkflowsRoutes,
	createWorkflowsRuntime,
	workflowsRuntimeOptionsFromEnvironment,
} from './server/index.ts';
import {
	WORKFLOW_EXECUTION_CAPABILITY,
	type WorkflowExecutionCapability,
} from './domain/types.ts';
import { workflowsDataClasses } from './services/data-classes.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createWorkflowsRuntime({
		...workflowsRuntimeOptionsFromEnvironment(
			context.environment,
			context.workspaceRoot,
		),
		databases: context.databases,
		capabilities: context.capabilities,
		/* Which roles a workspace defines is auth.core's answer, asked when a
		   graph carrying a human-approval node is validated, never cached, so a
		   role deleted since the last publish is caught by the next one. */
		roles: async (tenantId) =>
			(await (await context.auth.service()).listRoles(tenantId)).map(
				(role) => role.key,
			),
	});
	/* The runtime opens its database leases lazily, so the capability is a
	   forwarder rather than a resolved object: registration must not force a
	   connection at composition time. */
	const capability = async () =>
		(await runtime.service()).executionCapability();
	context.capabilities.register(WORKFLOW_EXECUTION_CAPABILITY, {
		listPublished: async (contextValue) =>
			(await capability()).listPublished(contextValue),
		getPublishedReference: async (workflowKey, contextValue) =>
			(await capability()).getPublishedReference(workflowKey, contextValue),
		enqueue: async (request, contextValue) =>
			(await capability()).enqueue(request, contextValue),
		getRun: async (runId, contextValue) =>
			(await capability()).getRun(runId, contextValue),
		cancel: async (runId, contextValue) =>
			(await capability()).cancel(runId, contextValue),
	} satisfies WorkflowExecutionCapability);
	/* The sweep, the export and the erasure run here, on this module's own
	   leases and under its own tenant transaction; the platform only holds the
	   declaration. */
	context.dataClasses.declare(workflowsDataClasses(() => runtime.repository()));
	return {
		routes: createWorkflowsRoutes(context.auth, runtime),
		start: () => runtime.start(),
		stop: () => runtime.stop(),
		dispose: () => runtime.dispose(),
	};
}
