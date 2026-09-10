import {
	assertRouteConflicts,
	createModuleWebRoutes,
	createApplicationRoutes,
	validateApplicationPath,
} from '@flowdular/server';
import { resolve } from 'node:path';
import { defineConfig, RenderRoute, ServerRoute } from '@octanejs/vite-plugin';
import {
	createAuthRoutes,
	principalFromContext,
	createAuthRuntime,
	createPlatformAgentRegistry,
	createPlatformCapabilityRegistry,
	createPlatformToolRegistry,
	authRuntimeOptionsFromEnvironment,
} from '@flowdular/module-auth/server';
import {
	composeModuleServer,
	moduleWebMounts,
	applicationBasePath,
} from './src/generated/modules.server.ts';
import {
	createPlatformDatabaseProvider,
	databaseProviderConfigFromEnvironment,
	loadPlatformEnvironmentFile,
	platformDatabaseConfigured,
} from './src/server/database.ts';
import {
	createReadinessEndpoint,
	healthEndpoint,
} from './src/server/health.ts';
import {
	activatePlatformRuntimeLifecycle,
	createPlatformRuntimeLifecycle,
	prepareAndActivatePlatformRuntimeLifecycle,
} from './src/server/lifecycle.ts';
import {
	clearSetupToken,
	createFirstRunSetup,
} from './src/server/setup/index.ts';

function checkedRoutes<T extends Parameters<typeof assertRouteConflicts>[0]>(
	routes: T,
): T {
	assertRouteConflicts(routes);
	return routes;
}

const SHELL = ['App', '/src/App.tsrx'] as const;
const apiNotFound = () =>
	new Response(
		JSON.stringify({
			error: {
				code: 'API_ROUTE_NOT_FOUND',
				message: 'The requested API route does not exist.',
			},
		}),
		{
			status: 404,
			headers: { 'content-type': 'application/json; charset=utf-8' },
		},
	);
const API_NOT_FOUND_ROUTES = [
	new ServerRoute({
		path: '/api',
		methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
		handler: apiNotFound,
	}),
	new ServerRoute({
		path: '/api/*path',
		methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
		handler: apiNotFound,
	}),
] as const;

const workspaceRoot = resolve(import.meta.dirname, '..');

/* The first-run installer and the application are alternatives, never
   neighbours. A deployment that names a database composes the application and
   has no reachable route that could re-point it; one that names none composes
   only the installer, which disappears at the next start. */
function createFirstRunConfig() {
	const setup = createFirstRunSetup({
		applicationPath: applicationBasePath,
		webMountPaths: moduleWebMounts.map((site) => site.path),
		environment: process.env,
		workspaceRoot,
	});
	return defineConfig({
		router: { routes: [healthEndpoint.serverRoute, ...setup.routes] },
	});
}

async function createPlatformConfig() {
	if (process.env.FD_INTERNAL_PLATFORM_TERMINATING === 'true') {
		throw new Error(
			'Platform startup was requested while the process is stopping.',
		);
	}
	loadPlatformEnvironmentFile(workspaceRoot);
	const configuredApplicationPath = validateApplicationPath(
		process.env.FD_APPLICATION_PATH ?? applicationBasePath,
	);
	if (!platformDatabaseConfigured(process.env)) return createFirstRunConfig();
	clearSetupToken(workspaceRoot);
	const lifecycle = createPlatformRuntimeLifecycle();
	const databases = createPlatformDatabaseProvider(
		databaseProviderConfigFromEnvironment(
			process.env.FD_INTERNAL_BUILD === 'true'
				? { ...process.env, NODE_ENV: 'development' }
				: process.env,
			workspaceRoot,
		),
	);
	lifecycle.add(() => databases.dispose());
	const authRuntime = createAuthRuntime({
		...authRuntimeOptionsFromEnvironment(process.env, workspaceRoot),
		applicationPath: configuredApplicationPath,
		databases,
	});
	lifecycle.add(() => authRuntime.dispose());
	try {
		/* Module APIs come from the generated composition. Enable or disable modules
		   with "pnpm flowdular module enable <id> --apply"; never wire them here by hand. */
		const settings = authRuntime.moduleSettings;
		const agentTools = createPlatformToolRegistry();
		const agentDefinitions = createPlatformAgentRegistry();
		const capabilities = createPlatformCapabilityRegistry();
		const readinessEndpoint = createReadinessEndpoint(databases);
		const moduleCompositions = composeModuleServer({
			environment: process.env,
			workspaceRoot,
			auth: authRuntime,
			settings,
			agentTools,
			agentDefinitions,
			capabilities,
			databases,
		});
		for (const composition of moduleCompositions) {
			if (composition.settings) settings.declare(composition.settings);
			if (composition.stop) lifecycle.addQuiesce(composition.stop);
			if (composition.dispose) lifecycle.add(composition.dispose);
		}
		agentDefinitions.seal();
		const config = defineConfig({
			middlewares: [lifecycle.middleware, authRuntime.middleware],
			router: {
				routes: checkedRoutes([
					...createApplicationRoutes({
						path: configuredApplicationPath,
						entry: SHELL,
						publicRoot: moduleWebMounts.some((site) => site.path === '/'),
					}),
					healthEndpoint.serverRoute,
					readinessEndpoint.serverRoute,
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
					// The explicit /api fallback is more specific than the workspace
					// params below and prevents API typos from rendering as pages.
					...API_NOT_FOUND_ROUTES,
					// Compatibility routes for slug-first bookmarks. The shell moves them
					// below /app, so module screens never need their own route entries here.
				]),
			},
		});
		// Bundling needs route and entry declarations, but must not activate
		// background producers or retain database leases in the build process.
		if (process.env.FD_INTERNAL_BUILD === 'true') {
			await lifecycle.retire();
			return config;
		}
		/* The next generation only opens its pools once the previous one has
		   finished closing, so two generations never hold the database at once. */
		await prepareAndActivatePlatformRuntimeLifecycle(lifecycle, [
			async () => {
				await databases.check();
			},
			...moduleCompositions.flatMap((composition) =>
				composition.prepare ? [composition.prepare] : [],
			),
		]);
		for (const composition of moduleCompositions) composition.start?.();
		return config;
	} catch (error) {
		void lifecycle.retire().catch((disposeError: unknown) => {
			console.error(
				'[flowdular] failed platform boot cleanup failed',
				disposeError,
			);
		});
		throw error;
	}
}

export default await createPlatformConfig();
