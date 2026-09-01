import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@coreloom/module-auth/server';
import {
	createExpensesRoutes,
	createExpensesRuntime,
	expensesRuntimeOptionsFromEnvironment,
} from './server/index.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createExpensesRuntime(
		expensesRuntimeOptionsFromEnvironment(
			context.environment,
			context.workspaceRoot,
		),
	);
	return { routes: createExpensesRoutes(context.auth, runtime) };
}
