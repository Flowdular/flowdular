import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { WORKFLOWS_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'workflows.navigation',
			label: 'Agentic Workflows',
			href: '/workflows',
			order: 50,
			permission: WORKFLOWS_PERMISSIONS.read,
		},
	],
	permissions: Object.values(WORKFLOWS_PERMISSIONS),
} satisfies RegisteredModule;

export { WORKFLOWS_PERMISSIONS } from './acl/permissions.ts';
export {
	WorkflowsService,
	WorkflowsServiceError,
} from './services/workflows-service.ts';
export type {
	CreateWorkflowsDefinitionInput,
	WorkflowsDefinition,
} from './domain/types.ts';
