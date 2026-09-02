import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@coreloom/module-auth/server';
import {
	createWorkflowsRoutes,
	createWorkflowsRuntime,
	workflowsRuntimeOptionsFromEnvironment,
} from './server/index.ts';
import { WORKFLOW_EXECUTION_CAPABILITY } from './domain/types.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createWorkflowsRuntime({
		...workflowsRuntimeOptionsFromEnvironment(
			context.environment,
			context.workspaceRoot,
		),
		capabilities: context.capabilities,
	});
	context.capabilities.register(
		WORKFLOW_EXECUTION_CAPABILITY,
		runtime.service().executionCapability(),
	);
	return {
		routes: createWorkflowsRoutes(context.auth, runtime),
		start: () => runtime.start(),
		stop: () => runtime.stop(),
		dispose: () => runtime.dispose(),
	};
}
