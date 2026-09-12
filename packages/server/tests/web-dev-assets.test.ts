import {
	createContext,
	createRouter,
	ServerRoute,
	type Route,
} from '@octanejs/app-core';
import { describe, expect, it } from 'vitest';
import {
	assertRouteConflicts,
	createApplicationRoutes,
	createModuleWebRoutes,
	defineWebSurface,
	type WebMount,
} from '../src/index.ts';

const root: WebMount = {
	id: 'store',
	moduleId: 'blog.core',
	surfaceId: 'site',
	path: '/',
	tenantId: 'tenant-a',
};
const blog: WebMount = {
	id: 'blog',
	moduleId: 'blog.core',
	surfaceId: 'site',
	path: '/blog',
	tenantId: 'tenant-b',
};

function surface() {
	return defineWebSurface({
		id: 'site',
		pages: [
			{
				id: 'index',
				path: '/',
				entry: ['Page', '@blog/module/web'],
				access: { kind: 'public' },
				load: () => ({}),
			},
			{
				id: 'post',
				path: '/posts/:slug',
				entry: ['Page', '@blog/module/web'],
				access: { kind: 'public' },
				load: () => ({}),
			},
		],
	});
}

/* The platform composes these route sets into one router, so what that router
   matches is the observation boundary for mount shadowing. */
function compose(mounts: readonly WebMount[], installed = true) {
	const routes: Route[] = [
		...createApplicationRoutes({
			path: '/app',
			entry: ['App', '/src/App.tsrx'],
			publicRoot: mounts.some((site) => site.path === '/'),
		}),
		new ServerRoute({
			path: '/api/*path',
			methods: ['GET', 'POST'],
			handler: () => new Response(null, { status: 404 }),
		}),
		...createModuleWebRoutes({
			modules: installed ? [{ moduleId: 'blog.core', web: [surface()] }] : [],
			mounts,
			resolveIdentity: () => null,
		}),
	];
	return createRouter(routes);
}

async function status(router: ReturnType<typeof compose>, path: string) {
	const match = router.match('GET', path)!;
	expect(match.route.type).toBe('server');
	const response = await (match.route as ServerRoute).handler(
		createContext(new Request('https://erp.example' + path), match.params),
	);
	return response.status;
}

describe('module web mounts and host-owned addresses', () => {
	/* Development transforms, built assets and platform/public files are served
	   by layers that only see a request the router left unmatched. */
	it.each([
		'/@vite/client',
		'/@id/virtual:octane-hydrate',
		'/@fs/Users/dev/app/packages/ui/src/fonts/Inter.woff2',
		'/@react-refresh',
		'/node_modules/.vite/deps/octane.js',
		'/src/App.tsrx',
		'/__vite_ping',
		'/assets/index-D4ta91.js',
		'/favicon.svg',
		'/og.png',
		'/robots.txt',
	])('leaves %s unclaimed when a module is mounted at the root', (path) => {
		expect(compose([root]).match('GET', path)).toBeNull();
	});

	it('still renders the pages a root mount declares', () => {
		const router = compose([root]);
		expect(router.match('GET', '/')?.route.path).toBe('/');
		expect(router.match('GET', '/posts/hello')?.route.path).toBe(
			'/posts/:slug',
		);
	});

	it('leaves the platform addresses to their own routes', () => {
		const router = compose([root]);
		for (const [path, expected] of [
			['/app', '/app'],
			['/app/acme/settings', '/app/:workspace/:view'],
			['/sign-in', '/sign-in'],
			['/auth/login', '/auth/login'],
			['/api/catalog/items', '/api/*path'],
		] as const)
			expect(router.match('GET', path)?.route.path).toBe(expected);
	});

	it('keeps a nested mount closed over its own subtree', async () => {
		expect(await status(compose([blog]), '/blog/unknown/deep')).toBe(404);
	});

	it('keeps a retired root mount closed at its configured address', async () => {
		expect(await status(compose([{ ...root, enabled: false }]), '/')).toBe(404);
		expect(await status(compose([root], false), '/')).toBe(404);
	});

	/* Releasing the origin is only safe because the legacy slug-first dashboard
	   routes and a root mount can never be composed together. */
	it.each([
		[root, true],
		[root, false],
		[{ ...root, enabled: false }, true],
	])(
		'refuses a root mount beside the slug-first dashboard',
		(site, installed) =>
			expect(() =>
				assertRouteConflicts([
					...createApplicationRoutes({
						path: '/app',
						entry: ['App', '/src/App.tsrx'],
						publicRoot: false,
					}),
					...createModuleWebRoutes({
						modules: installed
							? [{ moduleId: 'blog.core', web: [surface()] }]
							: [],
						mounts: [site],
						resolveIdentity: () => null,
					}),
				]),
			).toThrow(/duplicate route/),
	);
});
