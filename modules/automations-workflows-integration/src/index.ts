import type { ModuleManifest, RegisteredModule } from '@coreloom/contracts';
import manifest from '../module.json' with { type: 'json' };

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [],
	permissions: [],
} satisfies RegisteredModule;

export {
	createWorkflowAutomationTargetAdapter,
	registerAutomationsWorkflowsIntegration,
	WorkflowAutomationTargetError,
} from './server/adapter.ts';
