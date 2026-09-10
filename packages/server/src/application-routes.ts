import { injectHtmlHead } from './web-html.ts';
import {
	RenderRoute,
	ServerRoute,
	type Route,
	type RenderRouteEntry,
} from '@octanejs/app-core';

export function validateApplicationPath(path: string): string {
	if (
		path.length > 64 ||
		!/^\/[a-z][a-z0-9-]*$/.test(path) ||
		[
			'setup',
			'health',
			'ready',
			'assets',
			'auth',
			'api',
			'sites',
			'sign-in',
			'sign-up',
			'forgot-password',
			'reset-password',
			'accept-invitation',
		].includes(path.slice(1))
	)
		throw new Error('Invalid application path.');
	return path;
}

export function createApplicationRoutes(options: {
	readonly path: string;
	readonly entry: RenderRouteEntry;
	readonly publicRoot: boolean;
}): readonly Route[] {
	const base = validateApplicationPath(options.path);
	const paths = [
		'/auth',
		'/auth/login',
		'/auth/register',
		'/auth/forgot-password',
		'/auth/reset-password',
		'/auth/accept-invitation',
		'/auth/mfa',
		'/sign-in',
		'/sign-up',
		'/forgot-password',
		'/reset-password',
		'/accept-invitation',
		base,
		base + '/:workspace',
		base + '/:workspace/:view',
		...(!options.publicRoot ? ['/', '/:workspace', '/:workspace/:view'] : []),
	];
	const routes: Route[] = paths.map(
		(path) =>
			new RenderRoute({
				path,
				entry: options.entry,
				before: [
					async (context, next) => {
						context.state.set('flowdular.application.path', base);
						const response = await next();
						response.headers.set('cache-control', 'no-store');
						return injectHtmlHead(
							response,
							`<script id="flowdular-application-data" type="application/json">${JSON.stringify(base)}</script>`,
						);
					},
				],
			}),
	);
	if (base !== '/app') {
		for (const path of ['/app', '/app/*legacyPath'])
			routes.push(
				new ServerRoute({
					path,
					methods: ['GET', 'HEAD'],
					handler: (context) =>
						new Response(null, {
							status: 308,
							headers: {
								location:
									base + context.url.pathname.slice(4) + context.url.search,
								'cache-control': 'no-store',
							},
						}),
				}),
			);
	}
	return routes;
}
