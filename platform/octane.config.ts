import { resolve } from 'node:path';
import { defineConfig, RenderRoute, ServerRoute } from '@octanejs/vite-plugin';
import {
	createAuthRoutes,
	createAuthRuntime,
	createPlatformToolRegistry,
	authRuntimeOptionsFromEnvironment,
} from '@coreloom/module-auth/server';
import { composeModuleServer } from './src/generated/modules.server.ts';
import { healthEndpoint } from './src/server/health.ts';

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
const authRuntime = createAuthRuntime(
	authRuntimeOptionsFromEnvironment(process.env, workspaceRoot),
);
/* Module APIs come from the generated composition. Enable or disable modules
   with "pnpm oerp module enable <id> --apply"; never wire them here by hand. */
const settings = authRuntime.moduleSettings;
const agentTools = createPlatformToolRegistry();
const moduleCompositions = composeModuleServer({
	environment: process.env,
	workspaceRoot,
	auth: authRuntime,
	settings,
	agentTools,
});
for (const composition of moduleCompositions) {
	if (composition.settings) settings.declare(composition.settings);
}
for (const composition of moduleCompositions) composition.start?.();

export default defineConfig({
	middlewares: [authRuntime.middleware],
	router: {
		routes: [
			new RenderRoute({ path: '/', entry: SHELL }),
			new RenderRoute({ path: '/sign-in', entry: SHELL }),
			new RenderRoute({ path: '/sign-up', entry: SHELL }),
			healthEndpoint.serverRoute,
			...createAuthRoutes(authRuntime),
			...moduleCompositions.flatMap((composition) => composition.routes),
			// The explicit /api fallback is more specific than the workspace
			// params below and prevents API typos from rendering as pages.
			...API_NOT_FOUND_ROUTES,
			// Workspace-first URLs: /{workspaceSlug} and /{workspaceSlug}/{view}.
			// The shell resolves the slug client-side and canonicalizes the URL,
			// so module screens never need a route entry in this file.
			new RenderRoute({ path: '/:workspace', entry: SHELL }),
			new RenderRoute({ path: '/:workspace/:view', entry: SHELL }),
		],
	},
});
