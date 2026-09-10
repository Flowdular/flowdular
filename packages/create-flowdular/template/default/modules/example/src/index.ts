import type {
	ModuleManifest,
	RegisteredModule,
} from '@flowdular/sdk/contracts';
import manifest from '../module.json' with { type: 'json' };
import { EXAMPLE_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'example.navigation',
			label: 'Notes',
			href: '/example',
			order: 20,
			permission: EXAMPLE_PERMISSIONS.read,
		},
	],
	permissions: Object.values(EXAMPLE_PERMISSIONS),
} satisfies RegisteredModule;

export { EXAMPLE_PERMISSIONS } from './acl/permissions.ts';
export { NoteService, NoteServiceError } from './services/note-service.ts';
export type { CreateNoteInput, Note } from './domain/types.ts';
