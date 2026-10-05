import {
	assertRouteConflicts,
	createCorsMiddleware,
	createMailPort,
	createModuleMetrics,
	createModuleWebRoutes,
	createApplicationRoutes,
	createOpenApiRoutes,
	mailConfigFromEnvironment,
	serverEndpointCatalog,
	serverLogger,
	serverTracer,
	validateApplicationPath,
} from '@flowdular/server';
import {
	createDataClassRegistry,
	PLATFORM_SETTINGS_TENANT,
} from '@flowdular/kernel';
import { defineConfig, RenderRoute, ServerRoute } from '@octanejs/vite-plugin';
import {
	createAuthRoutes,
	endpointIdentityFromContext,
	isTokenPrincipal,
	mfaEnrolmentSatisfied,
	principalFromContext,
	createAuthRuntime,
	nodemailerSmtpTransport,
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
	createHealthEndpoint,
	createReadinessEndpoint,
} from './src/server/health.ts';
import {
	activatePlatformRuntimeLifecycle,
	createPlatformRuntimeLifecycle,
	prepareAndActivatePlatformRuntimeLifecycle,
} from './src/server/lifecycle.ts';
import { createMetricsRoutes, platformVersion } from './src/server/metrics.ts';
import {
	platformRuntimeRole,
	startModuleWorkers,
} from './src/server/runtime-role.ts';
import {
	createWorkerTickEndpoint,
	createWorkerTicker,
	workerTickConfigFromEnvironment,
} from './src/server/worker-tick.ts';
import { createPlatformObservability } from './src/server/tracing.ts';
import {
	createStorageKeyring,
	createStoragePort,
	createStorageRoutes,
	storageConfigFromEnvironment,
} from './src/server/storage.ts';
import {
	clearSetupToken,
	configuredDatabaseNeedsFirstRun,
	createFirstRunSetup,
} from './src/server/setup/index.ts';
import { findWorkspaceRoot } from './src/server/workspace-root.ts';

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

const workspaceRoot = findWorkspaceRoot(import.meta.dirname);

/* The installer and the application are alternatives. A configured database
   with no workspace still needs the first owner, but a failed database check
   is an outage and never opens setup against an established installation. */
function createFirstRunConfig(databasePreconfigured = false) {
	const setup = createFirstRunSetup({
		applicationPath: applicationBasePath,
		webMountPaths: moduleWebMounts.map((site) => site.path),
		environment: process.env,
		databasePreconfigured,
		workspaceRoot,
	});
	return defineConfig({
		router: { routes: [createHealthEndpoint().serverRoute, ...setup.routes] },
	});
}

async function createPlatformConfig() {
	if (process.env.FD_INTERNAL_PLATFORM_TERMINATING === 'true') {
		throw new Error(
			'Platform startup was requested while the process is stopping.',
		);
	}
	loadPlatformEnvironmentFile(workspaceRoot);
	const serverless = process.env.FD_DEPLOYMENT_TARGET === 'vercel';
	/* Every endpoint records itself as it is defined, so the API document
	   describes this generation and not the one it replaced. */
	serverEndpointCatalog().beginGeneration();
	const configuredApplicationPath = validateApplicationPath(
		process.env.FD_APPLICATION_PATH ?? applicationBasePath,
	);
	if (
		process.env.FD_INTERNAL_BUILD !== 'true' &&
		!platformDatabaseConfigured(process.env)
	) {
		if (serverless)
			throw new Error(
				'Vercel requires a configured external PostgreSQL database before deployment.',
			);
		return createFirstRunConfig();
	}
	if (
		process.env.FD_INTERNAL_BUILD !== 'true' &&
		(await configuredDatabaseNeedsFirstRun(process.env, workspaceRoot))
	) {
		if (serverless)
			throw new Error(
				'Finish first-run setup against the external database before deploying to Vercel.',
			);
		return createFirstRunConfig(true);
	}
	clearSetupToken(workspaceRoot);
	const runtimeRole = platformRuntimeRole(process.env);
	const workerTick =
		runtimeRole === 'tick'
			? workerTickConfigFromEnvironment(process.env)
			: null;
	const lifecycle = createPlatformRuntimeLifecycle();
	/* Composed first and drained last: a trace or an error report is evidence
	   about the boot that follows it, and both egresses refuse a misconfigured
	   endpoint here rather than at the first request that needed them. */
	const observability = createPlatformObservability({
		environment:
			process.env.FD_INTERNAL_BUILD === 'true'
				? { ...process.env, NODE_ENV: 'development' }
				: process.env,
	});
	lifecycle.addQuiesce(() => observability.dispose());
	const databases = createPlatformDatabaseProvider(
		databaseProviderConfigFromEnvironment(
			process.env.FD_INTERNAL_BUILD === 'true'
				? { ...process.env, NODE_ENV: 'development' }
				: process.env,
			workspaceRoot,
		),
	);
	lifecycle.add(() => databases.dispose());
	const storageKeyring = createStorageKeyring(process.env, workspaceRoot);
	const storage = createStoragePort(
		storageConfigFromEnvironment(
			process.env.FD_INTERNAL_BUILD === 'true'
				? { ...process.env, NODE_ENV: 'development' }
				: process.env,
			workspaceRoot,
		),
		{ keyring: storageKeyring },
	);
	lifecycle.add(() => storage.dispose());
	/* One outbound transport for the whole deployment. auth.core is only its
	   first sender; the SMTP client comes from that module because it is the one
	   that declares the dependency. */
	const mail = createMailPort(
		mailConfigFromEnvironment(
			process.env.FD_INTERNAL_BUILD === 'true'
				? { ...process.env, NODE_ENV: 'development' }
				: process.env,
		),
		{ createSmtpTransport: nodemailerSmtpTransport },
	);
	/* Created before the auth runtime so auth.core, which composes outside the
	   generated module list, declares its data classes into the same registry. */
	const dataClasses = createDataClassRegistry();
	const authRuntime = createAuthRuntime({
		...authRuntimeOptionsFromEnvironment(
			process.env.FD_INTERNAL_BUILD === 'true'
				? { ...process.env, NODE_ENV: 'development' }
				: process.env,
			workspaceRoot,
		),
		applicationPath: configuredApplicationPath,
		databases,
		dataClasses,
		mail,
		metrics: createModuleMetrics('auth.core'),
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
			dataClasses,
			databases,
			storage,
			/* The relay auth.core resolves per message from its stored settings,
			   falling back to the environment port above, so every module of the
			   installation sends through the same one. */
			mail: authRuntime.mail,
			/* Rebound to the composing module by the generated composition; this
			   binding is what a series the platform itself records would carry. */
			metrics: createModuleMetrics('platform'),
			tracer: serverTracer(),
		});
		for (const composition of moduleCompositions) {
			if (composition.settings) settings.declare(composition.settings);
			if (composition.stop) lifecycle.addQuiesce(composition.stop);
			if (composition.dispose) lifecycle.add(composition.dispose);
		}
		const ticker = workerTick
			? createWorkerTicker(moduleCompositions, {
					windowMs: workerTick.windowMs,
				})
			: null;
		/* Registered after the module stops, so retirement closes the open
		   window before those stops run again. */
		if (ticker) lifecycle.addQuiesce(() => ticker.close());
		agentDefinitions.seal();
		/* Sealed here rather than in a module: every composition has run, which
		   is exactly when the declarations are final and before any start hook
		   reads the catalogue. */
		dataClasses.seal();
		const config = defineConfig({
			middlewares: [
				/* Ahead of the lifecycle and the authentication: a cross-origin
				   preflight carries no credential and has to be answered before
				   anything asks for one. */
				createCorsMiddleware({
					allowOrigin: (origin) => authRuntime.apiOriginAllowed(origin),
				}),
				lifecycle.middleware,
				authRuntime.middleware,
			],
			router: {
				routes: checkedRoutes([
					...createApplicationRoutes({
						path: configuredApplicationPath,
						entry: SHELL,
						publicRoot: moduleWebMounts.some((site) => site.path === '/'),
					}),
					createHealthEndpoint().serverRoute,
					readinessEndpoint.serverRoute,
					...createMetricsRoutes({ environment: process.env }),
					...createOpenApiRoutes({
						resolveIdentity: endpointIdentityFromContext,
						publicBaseUrl: authRuntime.publicBaseUrl,
						version: platformVersion(),
					}),
					...createStorageRoutes({
						storage,
						keyring: storageKeyring,
						environment: process.env,
					}),
					...createAuthRoutes(authRuntime),
					...moduleCompositions.flatMap((composition) => composition.routes),
					...createModuleWebRoutes({
						modules: moduleCompositions,
						mounts: moduleWebMounts,
						applicationPath: configuredApplicationPath,
						/* A build composes with NODE_ENV forced to development, so the
						   flag asks for both: only a development server serves a page
						   whose stylesheets arrive after its markup. */
						development:
							process.env.NODE_ENV !== 'production' &&
							process.env.FD_INTERNAL_BUILD !== 'true',
						resolveIdentity: async (context) => {
							const principal = principalFromContext(context);
							if (!principal) return null;
							/* The /api gate does not reach these pages, and a member who
							   still owes enrolment must not read workspace data from one.
							   Machine credentials cannot enrol and stay exempt there too. */
							if (
								!isTokenPrincipal(context) &&
								!(await mfaEnrolmentSatisfied(authRuntime, principal))
							) {
								return null;
							}
							return {
								subjectId: principal.accountId,
								tenantId: principal.tenantId,
								permissions: new Set(principal.scopes),
							};
						},
					}),
					...(ticker && workerTick
						? [createWorkerTickEndpoint(ticker, workerTick).serverRoute]
						: []),
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
			/* Platform-scoped settings are read by background work before any
			   request could prime them; a workspace is primed by the
			   authentication middleware. */
			() => settings.prime(PLATFORM_SETTINGS_TENANT),
			...moduleCompositions.flatMap((composition) =>
				composition.prepare ? [composition.prepare] : [],
			),
		]);
		for (const composition of moduleCompositions) composition.start?.();
		await startModuleWorkers(moduleCompositions, runtimeRole);
		return config;
	} catch (error) {
		/* The boot failure is the one a reader needs; a cleanup failure after it
		   is a consequence, so it is logged under its own message. */
		serverLogger().error('platform boot failed', {
			module: 'platform',
			err: error,
		});
		void lifecycle.retire().catch((disposeError: unknown) => {
			serverLogger().error('platform boot cleanup failed', {
				module: 'platform',
				err: disposeError,
			});
		});
		throw error;
	}
}

export default await createPlatformConfig();
