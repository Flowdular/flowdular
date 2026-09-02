import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@coreloom/module-auth/server';
import { registerAutomationsWorkflowsIntegration } from './server/adapter.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	registerAutomationsWorkflowsIntegration(context.capabilities);
	return { routes: [] };
}
