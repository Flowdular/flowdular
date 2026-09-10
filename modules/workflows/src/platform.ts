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
	return {
		routes: createWorkflowsRoutes(context.auth, runtime),
		start: () => runtime.start(),
		stop: () => runtime.stop(),
		dispose: () => runtime.dispose(),
	};
}
