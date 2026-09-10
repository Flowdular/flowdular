import {
	assertRouteConflicts,
	createModuleWebRoutes,
	createApplicationRoutes,
	validateApplicationPath,
} from '@flowdular/sdk/server';
import { resolve } from 'node:path';
import { defineConfig, RenderRoute } from '@octanejs/vite-plugin';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRoutes,
	principalFromContext,
	createAuthRuntime,
	createPlatformAgentRegistry,
	createPlatformCapabilityRegistry,
	createPlatformToolRegistry,
} from '@flowdular/sdk/modules/auth/server';
import {
	composeModuleServer,
	moduleWebMounts,
	applicationBasePath,
} from './src/generated/modules.server.ts';
import {
	createPlatformDatabaseProvider,
	databaseProviderConfigFromEnvironment,
} from './src/server/database.ts';

function checkedRoutes<T extends Parameters<typeof assertRouteConflicts>[0]>(
	routes: T,
): T {
	assertRouteConflicts(routes);
	return routes;
}

const SHELL = ['App', '/src/App.tsrx'] as const;
const workspaceRoot = resolve(import.meta.dirname, '..');
const building = process.env.FD_INTERNAL_BUILD === 'true';

const databases = createPlatformDatabaseProvider(
	databaseProviderConfigFromEnvironment(
		building ? { ...process.env, NODE_ENV: 'development' } : process.env,
		workspaceRoot,
	),
);
const configuredApplicationPath = validateApplicationPath(
	process.env.FD_APPLICATION_PATH ?? applicationBasePath,
);
const authRuntime = createAuthRuntime({
	...authRuntimeOptionsFromEnvironment(process.env, workspaceRoot),
	applicationPath: configuredApplicationPath,
	databases,
});

/* Module APIs come from the generated composition. Enable or disable modules
   with "pnpm flowdular module enable <id> --apply"; never wire them here by hand. */
const settings = authRuntime.moduleSettings;
const agentDefinitions = createPlatformAgentRegistry();
const moduleCompositions = composeModuleServer({
	environment: process.env,
	workspaceRoot,
	auth: authRuntime,
	settings,
	agentTools: createPlatformToolRegistry(),
	agentDefinitions,
	capabilities: createPlatformCapabilityRegistry(),
	databases,
});
for (const composition of moduleCompositions) {
	if (composition.settings) settings.declare(composition.settings);
}
agentDefinitions.seal();

/* check() proves the runtime role holds neither SUPERUSER nor BYPASSRLS before
   any module reads a row. */
if (!building) {
	await databases.check();
	for (const composition of moduleCompositions) await composition.prepare?.();
	for (const composition of moduleCompositions) composition.start?.();
}

let stopping = false;
const shutdown = async () => {
	if (stopping) return;
	stopping = true;
	for (const composition of moduleCompositions) {
		await composition.stop?.();
		await composition.dispose?.();
	}
	await authRuntime.dispose();
	await databases.dispose();
};
// Bundling needs route declarations without background work or retained leases.
if (building) {
	await shutdown();
} else {
	process.once('SIGINT', () => void shutdown());
	process.once('SIGTERM', () => void shutdown());
}

export default defineConfig({
	middlewares: [authRuntime.middleware],
	router: {
		routes: checkedRoutes([
			...createApplicationRoutes({
				path: configuredApplicationPath,
				entry: SHELL,
				publicRoot: moduleWebMounts.some((site) => site.path === '/'),
			}),
			...createAuthRoutes(authRuntime),
			...moduleCompositions.flatMap((composition) => composition.routes),
			...createModuleWebRoutes({
				modules: moduleCompositions,
				mounts: moduleWebMounts,
				applicationPath: configuredApplicationPath,
				resolveIdentity: (context) => {
					const principal = principalFromContext(context);
					return principal
						? {
								subjectId: principal.accountId,
								tenantId: principal.tenantId,
								permissions: new Set(principal.scopes),
							}
						: null;
				},
			}),
		]),
	},
});
