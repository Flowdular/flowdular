import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { defineCliExtension } from '@flowdular/cli-protocol';
import { AUTH_SCOPES, OWNER_SCOPES, PLATFORM_SCOPES } from '../acl/scopes.ts';
import { localDatabaseProvider } from './database.ts';
import { runGreenfield } from './greenfield.ts';
import {
	addWorkspaceMember,
	createWorkspace,
	listWorkspaces,
} from './provisioning.ts';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
} from '../server/runtime.ts';

/* Scopes are declared once, in the module specification. Reading them from
   there keeps this command free of module code execution. */
export async function declaredScopes(
	workspaceRoot: string,
	moduleId: string,
	moduleRoot = join(workspaceRoot, 'modules/auth'),
): Promise<{ readonly directory: string; readonly scopes: readonly string[] }> {
	for (const root of new Set([
		join(workspaceRoot, 'modules'),
		dirname(moduleRoot),
	])) {
		for (const entry of await readdir(root)) {
			const specPath = join(root, entry, 'spec/module.yaml');
			let spec: { id?: string; permissions?: { id?: string }[] };
			try {
				spec = parseYaml(await readFile(specPath, 'utf8')) as typeof spec;
			} catch {
				continue;
			}
			if (spec.id !== moduleId) continue;
			return {
				directory: entry,
				scopes: (spec.permissions ?? [])
					.map((permission) => permission.id)
					.filter((id): id is string => typeof id === 'string'),
			};
		}
	}
	throw new Error(`No enabled module declares the id "${moduleId}".`);
}

export const cliExtension = defineCliExtension({
	protocolVersion: 1,
	moduleId: 'auth.core',
	commands: [
		{
			path: ['auth', 'scopes'],
			capability: {
				id: 'auth.scopes.list',
				version: 1,
				summary:
					'List authentication and platform scopes granted to new tenant owners.',
				risk: 'read',
				requiresApprovedSpec: false,
				supportsDryRun: false,
			},
			execute: () => ({
				data: {
					module: 'auth.core',
					authentication: Object.values(AUTH_SCOPES),
					platform: Object.values(PLATFORM_SCOPES),
					ownerDefaults: OWNER_SCOPES,
				},
				evidence: ['modules/auth/src/acl/scopes.ts'],
			}),
		},
		{
			path: ['auth', 'sync-scopes'],
			capability: {
				id: 'auth.scopes.sync',
				version: 1,
				summary:
					'Grant the scopes an enabled module declares to every workspace owner.',
				risk: 'process' as const,
				requiresApprovedSpec: false,
				supportsDryRun: true,
			},
			execute: async (context) => {
				const moduleId = context.flags.get('module');
				if (typeof moduleId !== 'string' || moduleId.trim().length === 0) {
					throw new Error('--module <id> is required.');
				}
				const declared = await declaredScopes(
					context.workspaceRoot,
					moduleId.trim(),
					context.moduleRoot,
				);
				const local = localDatabaseProvider(context.workspaceRoot);
				const databases = local.create();
				const runtime = createAuthRuntime({
					...authRuntimeOptionsFromEnvironment(
						process.env,
						context.workspaceRoot,
					),
					databases,
				});
				try {
					const service = await runtime.service();
					if (!context.apply) {
						return {
							data: {
								applied: false,
								moduleId: moduleId.trim(),
								scopes: declared.scopes,
								workspaces: await service.listTenants(),
							},
							evidence: [`modules/${declared.directory}/spec/module.yaml`],
						};
					}
					return {
						data: {
							applied: true,
							moduleId: moduleId.trim(),
							scopes: declared.scopes,
							granted: await service.grantModuleScopes(declared.scopes),
						},
						evidence: [
							`modules/${declared.directory}/spec/module.yaml`,
							local.location,
						],
					};
				} finally {
					await runtime.dispose();
					await databases.dispose();
				}
			},
		},
		{
			path: ['auth', 'workspaces'],
			capability: {
				id: 'auth.workspace.list',
				version: 1,
				summary: 'List the workspaces of this deployment and their owners.',
				risk: 'read',
				requiresApprovedSpec: false,
				supportsDryRun: false,
			},
			execute: listWorkspaces,
		},
		{
			path: ['auth', 'workspace-create'],
			capability: {
				id: 'auth.workspace.create',
				version: 1,
				summary:
					'Create a workspace with its owner account without opening public sign-up.',
				risk: 'process' as const,
				requiresApprovedSpec: false,
				supportsDryRun: true,
			},
			execute: createWorkspace,
		},
		{
			path: ['auth', 'member-add'],
			capability: {
				id: 'auth.member.add',
				version: 1,
				summary:
					'Add an account to a workspace with a role, or invite an unknown address.',
				risk: 'process' as const,
				requiresApprovedSpec: false,
				supportsDryRun: true,
			},
			execute: addWorkspaceMember,
		},
		{
			path: ['auth', 'greenfield'],
			capability: {
				id: 'auth.greenfield.reset',
				version: 1,
				summary:
					'Reset local auth and seed demo tenants, an admin, and a reduced-scope user.',
				risk: 'destructive',
				requiresApprovedSpec: false,
				supportsDryRun: true,
				localOnly: true,
				confirmation: 'reset-local-auth',
			},
			execute: runGreenfield,
		},
	],
});

export default cliExtension;
