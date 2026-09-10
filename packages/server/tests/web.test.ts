import {
	createContext,
	createRouter,
	ServerRoute,
	type RenderRoute,
} from '@octanejs/app-core';
import { describe, expect, it, vi } from 'vitest';
import {
	assertRouteConflicts,
	createModuleWebRoutes,
	defineWebSurface,
	validateWebMounts,
	type WebMount,
	type WebPage,
} from '../src/index.ts';

const mounts: readonly WebMount[] = [
	{
		id: 'acme',
		moduleId: 'demo.core',
		surfaceId: 'site',
		path: '/sites/acme',
		tenantId: 'tenant-a',
	},
	{
		id: 'other',
		moduleId: 'demo.core',
		surfaceId: 'site',
		path: '/sites/other',
		tenantId: 'tenant-b',
	},
];
const identity = {
	subjectId: 'owner',
	tenantId: 'tenant-a',
	permissions: new Set(['demo.read']),
};

function setup(
	access: WebPage['access'] = { kind: 'public' },
	load: WebPage['load'] = ({ site, params, identity }) => ({
		tenant: site.tenantId,
		slug: params.slug ?? null,
		authenticated: identity !== null,
	}),
) {
	const resolveIdentity = vi.fn(() => identity);
	const loader = vi.fn(load);
	const routes = createModuleWebRoutes({
		modules: [
			{
				moduleId: 'demo.core',
				web: [
					defineWebSurface({
						id: 'site',
						pages: [
							{
								id: 'index',
								path: '/',
								entry: ['Page', '@demo/module/web'],
								access,
								load: loader,
							},
							{
								id: 'record',
								path: '/records/:slug',
								entry: ['Page', '@demo/module/web'],
								access,
								load: loader,
							},
						],
					}),
				],
			},
		],
		mounts,
		resolveIdentity,
	});
	const call = async (path: string, method = 'GET', data = true) => {
		const url = new URL(path, 'https://example.test');
		const matched = createRouter([...routes]).match(method, url.pathname);
		if (!matched) return new Response(null, { status: 404 });
		const context = createContext(
			new Request(url, {
				method,
				headers: data ? { accept: 'application/vnd.flowdular.page+json' } : {},
			}),
			matched.params,
		);
		if (matched.route.type === 'server') return matched.route.handler(context);
		return (matched.route as RenderRoute).before[0]!(
			context,
			async () =>
				new Response('<html><head></head><body>Public page</body></html>', {
					headers: { 'content-type': 'text/html' },
				}),
		);
	};
	return { call, resolveIdentity, loader };
}

describe('module web surfaces', () => {
	it('preserves immutable redirect responses returned by a page loader', async () => {
		const app = setup({ kind: 'public' }, () =>
			Response.redirect('https://example.test/blog/new', 302),
		);
		const response = await app.call('/sites/acme');
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe(
			'https://example.test/blog/new',
		);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('vary')).toContain('Accept');
	});
	it('binds identical public slugs to the configured tenant and ignores dashboard identity and request tenant inputs', async () => {
		const app = setup();
		expect(
			await (
				await app.call('/sites/acme/records/same?tenantId=tenant-b')
			).json(),
		).toEqual({ tenant: 'tenant-a', slug: 'same', authenticated: false });
		expect(await (await app.call('/sites/other/records/same')).json()).toEqual({
			tenant: 'tenant-b',
			slug: 'same',
			authenticated: false,
		});
		expect(app.resolveIdentity).not.toHaveBeenCalled();
	});
	it('enforces identity, tenant membership and permission before the loader', async () => {
		const app = setup({ kind: 'permission', permission: 'demo.read' });
		expect((await app.call('/sites/acme')).status).toBe(200);
		app.loader.mockClear();
		expect((await app.call('/sites/other')).status).toBe(403);
		expect(app.loader).not.toHaveBeenCalled();
		app.resolveIdentity.mockReturnValueOnce(null as never);
		expect((await app.call('/sites/acme')).status).toBe(401);
		app.resolveIdentity.mockReturnValueOnce({
			...identity,
			permissions: new Set(),
		});
		expect((await app.call('/sites/acme')).status).toBe(403);
		expect(app.loader).not.toHaveBeenCalled();
	});
	it('returns real 404s for unpublished data and unmatched nested paths, and refuses writes', async () => {
		const app = setup(
			{ kind: 'public' },
			() => new Response('Not found', { status: 404 }),
		);
		expect(
			(await app.call('/sites/acme/records/draft', 'GET', false)).status,
		).toBe(404);
		expect((await app.call('/sites/acme/unknown/deep/path')).status).toBe(404);
		app.loader.mockClear();
		expect((await app.call('/sites/acme', 'POST')).status).toBe(405);
		expect(app.loader).not.toHaveBeenCalled();
	});
	it('keeps disabled and removed modules closed instead of falling into the shell', async () => {
		for (const site of [mounts[0]!, { ...mounts[0]!, enabled: false }]) {
			const routes = createModuleWebRoutes({
				modules: [],
				mounts: [site],
				resolveIdentity: () => null,
			});
			for (const path of [site.path, site.path + '/records/x']) {
				const match = createRouter([...routes]).match('GET', path)!;
				expect(match.route.type).toBe('server');
				expect(
					(
						await (match.route as ServerRoute).handler(
							createContext(new Request('https://test' + path), match.params),
						)
					).status,
				).toBe(404);
			}
		}
	});
	it('embeds only the explicit DTO, escapes script terminators and prevents shared caching', async () => {
		const data = { title: '</script><script>alert(1)</script>' };
		const app = setup({ kind: 'public' }, () => data);
		const html = await app.call('/sites/acme', 'GET', false);
		expect(html.headers.get('cache-control')).toBe('no-store');
		expect(html.headers.get('vary')).toContain('Accept');
		const body = await html.text();
		expect(body).not.toContain('<script>alert(1)');
		const payload = body.match(
			/id="flowdular-web-data"[^>]*>(.*?)<\/script>/,
		)![1]!;
		expect(JSON.parse(payload)).toEqual({ url: '/sites/acme', data });
		expect(body).not.toContain('tenant-a');
		expect(body).not.toContain('owner');
	});
	it('redacts thrown errors and bounds page data', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const app = setup({ kind: 'public' }, () => {
				throw new Error('database password secret');
			});
			expect(await (await app.call('/sites/acme')).text()).toBe(
				'Request failed',
			);
			expect(JSON.stringify(log.mock.calls)).not.toContain('password');
			expect(
				(
					await setup({ kind: 'public' }, () => 'x'.repeat(1_048_577)).call(
						'/sites/acme',
					)
				).status,
			).toBe(500);
		} finally {
			log.mockRestore();
		}
	});
	it.each([
		'/app/site',
		'/auth',
		'/api/public',
		'/sites/../private',
		'/sites/%61cme',
		'//host',
		'/sites/acme/',
	])('rejects unsafe or reserved mount %s', (path) => {
		expect(() => validateWebMounts([{ ...mounts[0], path }])).toThrow();
	});
	it('rejects overlapping mounts, duplicate route patterns and unnamed owners', () => {
		expect(() =>
			validateWebMounts([
				mounts[0],
				{ ...mounts[1], path: '/sites/acme/deeper' },
			]),
		).toThrow(/overlapping/);
		expect(() =>
			createModuleWebRoutes({
				modules: [{ web: [{ id: 'site', pages: [] }] }],
				mounts: [],
				resolveIdentity: () => null,
			}),
		).toThrow(/owner/);
		const handler = () => new Response(null);
		expect(() =>
			assertRouteConflicts([
				new ServerRoute({ path: '/thing/:id', methods: ['GET'], handler }),
				new ServerRoute({ path: '/thing/:slug', methods: ['GET'], handler }),
			]),
		).toThrow(/duplicate route/);
		expect(() =>
			assertRouteConflicts([
				new ServerRoute({ path: '/thing/:id', methods: ['GET'], handler }),
				new ServerRoute({ path: '/thing/:slug', methods: ['POST'], handler }),
			]),
		).not.toThrow();
	});
});
