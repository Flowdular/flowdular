import { createContext, createRouter } from '@octanejs/app-core';
import { expect, it } from 'vitest';
import {
	createApplicationRoutes,
	createModuleWebRoutes,
	assertRouteConflicts,
	validateApplicationPath,
} from '../src/index.ts';

it('serves a public root alongside a configurable dashboard and preserves legacy bookmarks', async () => {
	const routes = [
		...createApplicationRoutes({
			path: '/backoffice',
			entry: ['App', '/src/App.tsrx'],
			publicRoot: true,
		}),
		...createModuleWebRoutes({
			applicationPath: '/backoffice',
			mounts: [
				{
					id: 'store',
					moduleId: 'store.core',
					surfaceId: 'front',
					path: '/',
					tenantId: 'tenant-a',
				},
			],
			modules: [
				{
					moduleId: 'store.core',
					web: [
						{
							id: 'front',
							pages: [
								{
									id: 'home',
									path: '/',
									entry: ['Page', '@store/module/web'],
									access: { kind: 'public' },
									load: () => ({ title: 'Store' }),
								},
							],
						},
					],
				},
			],
			resolveIdentity: () => null,
		}),
	];
	assertRouteConflicts(routes);
	const router = createRouter(routes);
	expect(router.match('GET', '/')?.route.type).toBe('render');
	const office = router.match('GET', '/backoffice/acme/settings')!;
	expect(office.route.type).toBe('render');
	if (office.route.type !== 'render') throw new Error('Missing dashboard');
	const context = createContext(
		new Request('https://example.test/backoffice/acme/settings'),
		office.params,
	);
	const response = await office.route.before[0]!(
		context,
		async () =>
			new Response('<html><head></head><body>Dashboard</body></html>', {
				headers: { 'content-type': 'text/html' },
			}),
	);
	expect(context.state.get('flowdular.application.path')).toBe('/backoffice');
	expect(await response.text()).toContain(
		'id="flowdular-application-data" type="application/json">"/backoffice"',
	);
	const legacy = router.match('GET', '/app/acme/settings')!;
	if (legacy.route.type !== 'server')
		throw new Error('Missing legacy redirect');
	const redirect = await legacy.route.handler(
		createContext(
			new Request('https://example.test/app/acme/settings?q=1'),
			legacy.params,
		),
	);
	expect(redirect.status).toBe(308);
	expect(redirect.headers.get('location')).toBe(
		'/backoffice/acme/settings?q=1',
	);
	expect(router.match('GET', '/unknown/deep')?.route.type).toBe('server');
});

it.each([
	'/',
	'//evil.test',
	'/api',
	'/auth',
	'/setup',
	'/assets',
	'/back office',
	'/backoffice/admin',
	'/backoffice?x=1',
	'/' + 'a'.repeat(64),
])('rejects invalid dashboard path %s', (path) => {
	expect(() => validateApplicationPath(path)).toThrow();
});

it('rejects mounts taking over the configured dashboard namespace', () => {
	expect(() =>
		createModuleWebRoutes({
			applicationPath: '/backoffice',
			modules: [],
			mounts: [
				{
					id: 'store',
					moduleId: 'store.core',
					surfaceId: 'front',
					path: '/backoffice/store',
					tenantId: 'tenant-a',
				},
			],
			resolveIdentity: () => null,
		}),
	).toThrow(/overlaps/);
});
