import {
	assertRouteConflicts,
	createCorsMiddleware,
	createModuleMetrics,
	createModuleWebRoutes,
	createApplicationRoutes,
	createOpenApiRoutes,
	serverTracer,
	validateApplicationPath,
	createMailPort,
	mailConfigFromEnvironment,
	serverLogger,
} from '@flowdular/sdk/server';
import {
	createDataClassRegistry,
	PLATFORM_SETTINGS_TENANT,
} from '@flowdular/sdk/kernel';
import { defineConfig, RenderRoute } from '@octanejs/vite-plugin';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRoutes,
	endpointIdentityFromContext,
	isTokenPrincipal,
	mfaEnrolmentSatisfied,
	principalFromContext,
	createAuthRuntime,
	createPlatformAgentRegistry,
	createPlatformCapabilityRegistry,
	createPlatformToolRegistry,
	nodemailerSmtpTransport,
} from '@flowdular/sdk/modules/auth/server';
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
	createPlatformRuntimeLifecycle,
	prepareAndActivatePlatformRuntimeLifecycle,
} from './src/server/lifecycle.ts';
import { createMetricsRoutes } from './src/server/metrics.ts';
import {
	platformRuntimeRole,
	startModuleWorkers,
} from './src/server/runtime-role.ts';
import {
	createWorkerTickEndpoint,
	createWorkerTicker,
	WORKER_TICK_PATH,
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
	createInPlaceFirstRun,
} from './src/server/setup/index.ts';
import { findWorkspaceRoot } from './src/server/workspace-root.ts';

function checkedRoutes<T extends Parameters<typeof assertRouteConflicts>[0]>(
	routes: T,
): T {
	assertRouteConflicts(routes);
	return routes;
}

const SHELL = ['App', '/src/App.tsrx'] as const;
const workspaceRoot = findWorkspaceRoot(import.meta.dirname);
const building = process.env.FD_INTERNAL_BUILD === 'true';

function firstRunConfig(databasePreconfigured = false) {
	const setup = createFirstRunSetup({
		applicationPath: applicationBasePath,
		webMountPaths: moduleWebMounts.map((site) => site.path),
		environment: process.env,
		databasePreconfigured,
		workspaceRoot,
	});
	return defineConfig({
		router: {
			routes: checkedRoutes([healthEndpoint.serverRoute, ...setup.routes]),
		},
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
	if (!building && !platformDatabaseConfigured(process.env)) {
		if (serverless)
			throw new Error(
				'Vercel requires a configured external PostgreSQL database before deployment.',
			);
		return firstRunConfig();
	}
	/* A Vercel Function can neither restart into the application after setup
	   nor keep a token file, so it composes the application and serves setup
	   inside it until the first workspace exists. */
	const needsFirstRun =
		!building &&
		(await configuredDatabaseNeedsFirstRun(process.env, workspaceRoot));
	if (needsFirstRun && !serverless) return firstRunConfig(true);
	clearSetupToken(workspaceRoot);
	const runtimeRole = platformRuntimeRole(process.env);
	const workerTick =
		runtimeRole === 'tick'
			? workerTickConfigFromEnvironment(process.env)
			: null;

	/* Composed first and drained last: a trace or an error report is evidence about
   the boot that follows it, and both egresses refuse a misconfigured endpoint
   here rather than at the first request that needed them. */
	const observability = createPlatformObservability({
		environment: building
			? { ...process.env, NODE_ENV: 'development' }
			: process.env,
	});
	const databases = createPlatformDatabaseProvider(
		databaseProviderConfigFromEnvironment(
			building ? { ...process.env, NODE_ENV: 'development' } : process.env,
			workspaceRoot,
		),
	);
	const storageKeyring = createStorageKeyring(process.env, workspaceRoot);
	const storage = createStoragePort(
		storageConfigFromEnvironment(
			building ? { ...process.env, NODE_ENV: 'development' } : process.env,
			workspaceRoot,
		),
		{ keyring: storageKeyring },
	);
	const configuredApplicationPath = validateApplicationPath(
		process.env.FD_APPLICATION_PATH ?? applicationBasePath,
	);
	/* One outbound transport for the whole deployment. auth.core is only its
   first sender; the SMTP client comes from that module because it is the one
   that declares the dependency. */
	const mail = createMailPort(
		mailConfigFromEnvironment(
			building ? { ...process.env, NODE_ENV: 'development' } : process.env,
		),
		{ createSmtpTransport: nodemailerSmtpTransport },
	);
	/* Created before the auth runtime so auth.core, which composes outside the
   generated module list, declares its data classes into the same registry. */
	const dataClasses = createDataClassRegistry();
	const authRuntime = createAuthRuntime({
		...authRuntimeOptionsFromEnvironment(
			building ? { ...process.env, NODE_ENV: 'development' } : process.env,
			workspaceRoot,
		),
		applicationPath: configuredApplicationPath,
		databases,
		dataClasses,
		mail,
		metrics: createModuleMetrics('auth.core'),
	});

	/* Module APIs come from the generated composition. Enable or disable modules
   with "pnpm flowdular module enable <id> --apply"; never wire them here by hand. */
	const settings = authRuntime.moduleSettings;
	const firstRun = needsFirstRun
		? createInPlaceFirstRun({
				environment: process.env,
				workspaceRoot,
				applicationPath: configuredApplicationPath,
				webMountPaths: moduleWebMounts.map((site) => site.path),
				passThrough: ['/api/health', '/api/ready', WORKER_TICK_PATH],
				workspaceExists: async () =>
					(await authRuntime.service()).hasAnyTenant(),
			})
		: null;
	const agentDefinitions = createPlatformAgentRegistry();
	const moduleCompositions = composeModuleServer({
		environment: process.env,
		workspaceRoot,
		auth: authRuntime,
		settings,
		agentTools: createPlatformToolRegistry(),
		agentDefinitions,
		capabilities: createPlatformCapabilityRegistry(),
		dataClasses,
		databases,
		storage,
		/* The relay auth.core resolves per message from its stored settings, falling
	   back to the environment port above, so every module of the installation
	   sends through the same one. */
		mail: authRuntime.mail,
		/* Rebound to the composing module by the generated composition; this binding
	   is what a series the platform itself records would carry. */
		metrics: createModuleMetrics('platform'),
		tracer: serverTracer(),
	});
	for (const composition of moduleCompositions) {
		if (composition.settings) settings.declare(composition.settings);
	}
	const ticker = workerTick
		? createWorkerTicker(moduleCompositions, { windowMs: workerTick.windowMs })
		: null;
	agentDefinitions.seal();
	/* Sealed once every composition has run and before any start hook reads the
   catalogue, so every reader sees the declarations the modules agreed on. */
	dataClasses.seal();

	/* Each evaluation of this file is one generation, and Vite evaluates it more
	   than once per process. The generation retires when the next one is
	   prepared, when the development server stops, or on a stop signal. */
	const lifecycle = createPlatformRuntimeLifecycle();
	lifecycle.add(async () => {
		await ticker?.close();
		for (const composition of moduleCompositions) {
			await composition.stop?.();
			await composition.dispose?.();
		}
		await authRuntime.dispose();
		await storage.dispose();
		await databases.dispose();
		/* Last, so the spans and error reports this process queued while it stopped
	   still leave with it. */
		await observability.dispose();
	});

	/* check() proves the runtime role holds neither SUPERUSER nor BYPASSRLS before
   any module reads a row. */
	if (!building) {
		try {
			/* The previous generation retires once this one is prepared, and this
			   one starts its workers only after the previous has drained. */
			await prepareAndActivatePlatformRuntimeLifecycle(lifecycle, [
				async () => {
					await databases.check();
				},
				/* Platform-scoped settings are read by background work before any request
			   could prime them; a workspace is primed by the authentication middleware. */
				() => settings.prime(PLATFORM_SETTINGS_TENANT),
				...moduleCompositions.map(
					(composition) => () => composition.prepare?.(),
				),
			]);
			/* A stop that arrived while this generation was preparing retired only
			   the generations active then, so this one retires itself. */
			if (process.env.FD_INTERNAL_PLATFORM_TERMINATING === 'true') {
				throw new Error(
					'Platform startup was requested while the process is stopping.',
				);
			}
			for (const composition of moduleCompositions) composition.start?.();
			await startModuleWorkers(moduleCompositions, runtimeRole);
		} catch (error) {
			/* A worker that started before the failure would keep running in a
		   process that never serves. The boot failure is the one rethrown. */
			await lifecycle.retire().catch((cleanupError: unknown) => {
				serverLogger().error('platform boot cleanup failed', {
					module: 'platform',
					err: cleanupError,
				});
			});
			throw error;
		}
	}

	// Bundling needs route declarations without background work or retained leases.
	if (building) {
		await lifecycle.retire();
	} else {
		/* scripts/dev.mjs retires every generation itself; a production server
		   has only these. */
		const retire = () =>
			void lifecycle.retire().catch((error: unknown) => {
				serverLogger().error('platform shutdown failed', {
					module: 'platform',
					err: error,
				});
			});
		process.once('SIGINT', retire);
		process.once('SIGTERM', retire);
		lifecycle.add(() => {
			process.off('SIGINT', retire);
			process.off('SIGTERM', retire);
		});
	}

	return defineConfig({
		middlewares: [
			/* Ahead of the authentication: a cross-origin preflight carries no
		   credential and has to be answered before anything asks for one. The
		   origins come from the API tokens this workspace issued. */
			createCorsMiddleware({
				allowOrigin: (origin) => authRuntime.apiOriginAllowed(origin),
			}),
			lifecycle.middleware,
			...(firstRun ? [firstRun.middleware] : []),
			authRuntime.middleware,
		],
		router: {
			routes: checkedRoutes([
				...createApplicationRoutes({
					path: configuredApplicationPath,
					entry: SHELL,
					publicRoot: moduleWebMounts.some((site) => site.path === '/'),
				}),
				healthEndpoint.serverRoute,
				createReadinessEndpoint(databases).serverRoute,
				...(ticker && workerTick
					? [createWorkerTickEndpoint(ticker, workerTick).serverRoute]
					: []),
				...createMetricsRoutes({ environment: process.env }),
				/* Describes every operation the presented credential may call, built
			   from the endpoints this application composed. */
				...createOpenApiRoutes({
					resolveIdentity: endpointIdentityFromContext,
					publicBaseUrl: authRuntime.publicBaseUrl,
				}),
				...createStorageRoutes({
					storage,
					keyring: storageKeyring,
					environment: process.env,
				}),
				...createAuthRoutes(authRuntime),
				...(firstRun?.routes ?? []),
				...moduleCompositions.flatMap((composition) => composition.routes),
				...createModuleWebRoutes({
					modules: moduleCompositions,
					mounts: moduleWebMounts,
					applicationPath: configuredApplicationPath,
					/* A build composes with NODE_ENV forced to development, so the flag
				   asks for both: only a development server serves a page whose
				   stylesheets arrive after its markup. */
					development: !building && process.env.NODE_ENV !== 'production',
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
			]),
		},
	});
}

export default await createPlatformConfig();
