import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	AUTOMATION_EXECUTION_CAPABILITY,
	type AutomationExecutionCapability,
} from '@flowdular/module-automations/server';
import { registerAutomationsWorkflowsIntegration } from './server/adapter.ts';
import { createAutomationWorkflowActionTools } from './server/tools.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	registerAutomationsWorkflowsIntegration(context.capabilities);
	context.agentTools.register(
		createAutomationWorkflowActionTools(() =>
			context.capabilities.get<AutomationExecutionCapability>(
				AUTOMATION_EXECUTION_CAPABILITY,
			),
		),
	);
	return { routes: [] };
}
