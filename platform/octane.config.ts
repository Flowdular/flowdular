import { resolve } from 'node:path';
import { defineConfig, RenderRoute, ServerRoute } from '@octanejs/vite-plugin';
import {
	createAuthRoutes,
	createAuthRuntime,
	createPlatformAgentRegistry,
	createPlatformCapabilityRegistry,
	createPlatformToolRegistry,
	authRuntimeOptionsFromEnvironment,
} from '@coreloom/module-auth/server';
import { composeModuleServer } from './src/generated/modules.server.ts';
import { healthEndpoint } from './src/server/health.ts';
import {
	activatePlatformRuntimeLifecycle,
	createPlatformRuntimeLifecycle,
	prepareAndActivatePlatformRuntimeLifecycle,
} from './src/server/lifecycle.ts';

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

async function createPlatformConfig() {
	if (process.env.CL_INTERNAL_PLATFORM_TERMINATING === 'true') {
		throw new Error(
			'Platform startup was requested while the process is stopping.',
		);
	}
	const lifecycle = createPlatformRuntimeLifecycle();
	const authRuntime = createAuthRuntime(
		authRuntimeOptionsFromEnvironment(process.env, workspaceRoot),
	);
	lifecycle.add(() => authRuntime.dispose());
	try {
		/* Module APIs come from the generated composition. Enable or disable modules
		   with "pnpm coreloom module enable <id> --apply"; never wire them here by hand. */
		const settings = authRuntime.moduleSettings;
		const agentTools = createPlatformToolRegistry();
		const agentDefinitions = createPlatformAgentRegistry();
		const capabilities = createPlatformCapabilityRegistry();
		const moduleCompositions = composeModuleServer({
			environment: process.env,
			workspaceRoot,
			auth: authRuntime,
			settings,
			agentTools,
			agentDefinitions,
			capabilities,
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
				routes: [
					new RenderRoute({ path: '/', entry: SHELL }),
					new RenderRoute({ path: '/auth', entry: SHELL }),
					new RenderRoute({ path: '/auth/login', entry: SHELL }),
					new RenderRoute({ path: '/auth/register', entry: SHELL }),
					new RenderRoute({ path: '/auth/forgot-password', entry: SHELL }),
					new RenderRoute({ path: '/auth/reset-password', entry: SHELL }),
					new RenderRoute({ path: '/auth/accept-invitation', entry: SHELL }),
					new RenderRoute({ path: '/auth/mfa', entry: SHELL }),
					new RenderRoute({ path: '/sign-in', entry: SHELL }),
					new RenderRoute({ path: '/sign-up', entry: SHELL }),
					new RenderRoute({ path: '/forgot-password', entry: SHELL }),
					new RenderRoute({ path: '/reset-password', entry: SHELL }),
					new RenderRoute({ path: '/accept-invitation', entry: SHELL }),
					new RenderRoute({ path: '/app', entry: SHELL }),
					new RenderRoute({ path: '/app/:workspace', entry: SHELL }),
					new RenderRoute({ path: '/app/:workspace/:view', entry: SHELL }),
					healthEndpoint.serverRoute,
					...createAuthRoutes(authRuntime),
					...moduleCompositions.flatMap((composition) => composition.routes),
					// The explicit /api fallback is more specific than the workspace
					// params below and prevents API typos from rendering as pages.
					...API_NOT_FOUND_ROUTES,
					// Compatibility routes for slug-first bookmarks. The shell moves them
					// below /app, so module screens never need their own route entries here.
					new RenderRoute({ path: '/:workspace', entry: SHELL }),
					new RenderRoute({ path: '/:workspace/:view', entry: SHELL }),
				],
			},
		});
		/* No new SQLite connection opens until the previous generation finished
		   closing. SQLite retains lock file descriptors when old and new WAL
		   connections overlap, even when the old DatabaseSync is then closed. */
		await prepareAndActivatePlatformRuntimeLifecycle(
			lifecycle,
			moduleCompositions.flatMap((composition) =>
				composition.prepare ? [composition.prepare] : [],
			),
		);
		for (const composition of moduleCompositions) composition.start?.();
		return config;
	} catch (error) {
		void lifecycle.retire().catch((disposeError: unknown) => {
			console.error(
				'[coreloom] failed platform boot cleanup failed',
				disposeError,
			);
		});
		throw error;
	}
}

export default await createPlatformConfig();
