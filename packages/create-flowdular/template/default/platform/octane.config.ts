import {
	assertRouteConflicts,
	createModuleMetrics,
	createModuleWebRoutes,
	createApplicationRoutes,
	serverTracer,
	validateApplicationPath,
	createMailPort,
	mailConfigFromEnvironment,
} from '@flowdular/sdk/server';
import { createDataClassRegistry } from '@flowdular/sdk/kernel';
import { resolve } from 'node:path';
import { defineConfig, RenderRoute } from '@octanejs/vite-plugin';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRoutes,
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
} from './src/server/database.ts';
import {
	createReadinessEndpoint,
	healthEndpoint,
} from './src/server/health.ts';
import { createMetricsRoutes } from './src/server/metrics.ts';
import { createPlatformObservability } from './src/server/tracing.ts';
import {
	createStorageKeyring,
	createStoragePort,
	createStorageRoutes,
	storageConfigFromEnvironment,
} from './src/server/storage.ts';

function checkedRoutes<T extends Parameters<typeof assertRouteConflicts>[0]>(
	routes: T,
): T {
	assertRouteConflicts(routes);
	return routes;
}

const SHELL = ['App', '/src/App.tsrx'] as const;
const workspaceRoot = resolve(import.meta.dirname, '..');
const building = process.env.FD_INTERNAL_BUILD === 'true';

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
	mail,
	/* Rebound to the composing module by the generated composition; this binding
	   is what a series the platform itself records would carry. */
	metrics: createModuleMetrics('platform'),
	tracer: serverTracer(),
});
for (const composition of moduleCompositions) {
	if (composition.settings) settings.declare(composition.settings);
}
agentDefinitions.seal();
/* Sealed once every composition has run and before any start hook reads the
   catalogue, so every reader sees the declarations the modules agreed on. */
dataClasses.seal();

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
	await storage.dispose();
	await databases.dispose();
	/* Last, so the spans and error reports this process queued while it stopped
	   still leave with it. */
	await observability.dispose();
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
			healthEndpoint.serverRoute,
			createReadinessEndpoint(databases).serverRoute,
			...createMetricsRoutes({ environment: process.env }),
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
