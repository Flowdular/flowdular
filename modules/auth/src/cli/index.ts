import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { defineCliExtension } from '@coreloom/cli-protocol';
import { AUTH_SCOPES, OWNER_SCOPES, PLATFORM_SCOPES } from '../acl/scopes.ts';
import { runGreenfield } from './greenfield.ts';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
} from '../server/runtime.ts';

/* Scopes are declared once, in the module specification. Reading them from
   there keeps this command free of module code execution. */
async function declaredScopes(
	workspaceRoot: string,
	moduleId: string,
): Promise<{ readonly directory: string; readonly scopes: readonly string[] }> {
	for (const entry of await readdir(join(workspaceRoot, 'modules'))) {
		const specPath = join(workspaceRoot, 'modules', entry, 'spec/module.yaml');
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
				);
				const runtime = createAuthRuntime(
					authRuntimeOptionsFromEnvironment(process.env, context.workspaceRoot),
				);
				if (!context.apply) {
					return {
						data: {
							applied: false,
							moduleId: moduleId.trim(),
							scopes: declared.scopes,
							workspaces: runtime.service().listTenants(),
						},
						evidence: [`modules/${declared.directory}/spec/module.yaml`],
					};
				}
				return {
					data: {
						applied: true,
						moduleId: moduleId.trim(),
						scopes: declared.scopes,
						granted: runtime.service().grantModuleScopes(declared.scopes),
					},
					evidence: [
						`modules/${declared.directory}/spec/module.yaml`,
						'.coreloom/data/auth.db',
					],
				};
			},
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
