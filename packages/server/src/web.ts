import { validateApplicationPath } from './application-routes.ts';
import {
	RenderRoute,
	ServerRoute,
	type Context,
	type Middleware,
	type Route,
} from '@octanejs/app-core';
import { webHtmlResponse } from './web-html.ts';

import type {
	WebMount,
	WebIdentity,
	WebPage,
	WebPageContext,
	ModuleWebSurface,
	WebModuleComposition,
} from '@flowdular/contracts';
export type {
	WebMount,
	WebIdentity,
	WebAccess,
	WebJson,
	WebPage,
	WebPageContext,
	ModuleWebSurface,
	WebModuleComposition,
} from '@flowdular/contracts';

const DATA_STATE = 'flowdular.web.data';
const DATA_ACCEPT = 'application/vnd.flowdular.page+json';
const RESERVED = new Set([
	'setup',
	'health',
	'ready',
	'assets',
	'app',
	'api',
	'auth',
	'sign-in',
	'sign-up',
	'forgot-password',
	'reset-password',
	'accept-invitation',
]);
const ID = /^[a-z][a-z0-9-]*$/;
const MODULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

function invalid(message: string): never {
	throw new Error(`Invalid web configuration: ${message}`);
}

export function validateWebMounts(input: unknown): readonly WebMount[] {
	if (!Array.isArray(input) || input.length > 256)
		invalid('mounts must be an array of at most 256 entries.');
	const ids = new Set<string>();
	const paths: string[] = [];
	return Object.freeze(
		input.map((value: WebMount) => {
			if (
				!value ||
				typeof value.id !== 'string' ||
				typeof value.moduleId !== 'string' ||
				typeof value.surfaceId !== 'string' ||
				!ID.test(value.id) ||
				!MODULE_ID.test(value.moduleId) ||
				!ID.test(value.surfaceId) ||
				typeof value.tenantId !== 'string' ||
				!value.tenantId.trim() ||
				value.tenantId !== value.tenantId.trim() ||
				value.tenantId.length > 128 ||
				/[\u0000-\u001f]/.test(value.tenantId) ||
				typeof value.path !== 'string' ||
				value.path.length > 256 ||
				!/^(?:\/|\/[a-z0-9-]+(?:\/[a-z0-9-]+)*)$/.test(value.path) ||
				RESERVED.has(value.path.split('/')[1]!) ||
				(value.enabled !== undefined && typeof value.enabled !== 'boolean')
			)
				invalid('invalid mount.');
			if (ids.has(value.id)) invalid(`duplicate mount id ${value.id}.`);
			ids.add(value.id);
			if (
				paths.some(
					(path) =>
						path === value.path ||
						path.startsWith(value.path + '/') ||
						value.path.startsWith(path + '/'),
				)
			)
				invalid(`overlapping mount ${value.path}.`);
			paths.push(value.path);
			return Object.freeze({
				id: value.id,
				moduleId: value.moduleId,
				surfaceId: value.surfaceId,
				tenantId: value.tenantId,
				path: value.path,
				enabled: value.enabled !== false,
			});
		}),
	);
}

function pageShape(path: string): string {
	return path
		.split('/')
		.map((part) =>
			part.startsWith(':') ? ':' : part.startsWith('*') ? '*' : part,
		)
		.join('/');
}

/** Detect equivalent patterns independently of parameter names and module order. */
export function assertRouteConflicts(routes: readonly Route[]): void {
	const seen = new Map<string, Set<string>>();
	for (const route of routes) {
		const shape = pageShape(route.path);
		// Render routes match every method before their access guard runs.
		const methods =
			route.type === 'server'
				? route.methods
				: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
		const used = seen.get(shape) ?? new Set<string>();
		for (const method of methods) {
			if (used.has(method.toUpperCase()))
				invalid(`duplicate route ${method} ${route.path}.`);
			used.add(method.toUpperCase());
		}
		seen.set(shape, used);
	}
}

export function defineWebSurface(surface: ModuleWebSurface): ModuleWebSurface {
	if (
		!surface ||
		typeof surface.id !== 'string' ||
		!ID.test(surface.id) ||
		!Array.isArray(surface.pages) ||
		!surface.pages.length ||
		surface.pages.length > 128
	)
		invalid('invalid surface.');
	const ids = new Set<string>();
	const patterns = new Set<string>();
	const paths: string[] = [];
	for (const page of surface.pages) {
		if (
			!page ||
			typeof page.id !== 'string' ||
			!ID.test(page.id) ||
			typeof page.path !== 'string' ||
			page.path.length > 256 ||
			!/^(?:\/|(?:\/(?:[a-z0-9-]+|:[a-z][a-zA-Z0-9]*))+)$/.test(page.path) ||
			!Array.isArray(page.entry) ||
			page.entry.length !== 2 ||
			!/^[A-Za-z_$][\w$]*$/.test(page.entry[0]) ||
			!safeEntry(page.entry[1]) ||
			(page.layout !== undefined && !safeEntry(page.layout)) ||
			typeof page.load !== 'function' ||
			!page.access ||
			!['public', 'authenticated', 'permission'].includes(page.access.kind) ||
			(page.access.kind === 'permission' && !page.access.permission?.trim())
		)
			invalid(`invalid page in ${surface.id}.`);
		const names = page.path
			.split('/')
			.filter((part: string) => part.startsWith(':'));
		if (
			new Set(names).size !== names.length ||
			ids.has(page.id) ||
			patterns.has(pageShape(page.path))
		)
			invalid(`duplicate page or pattern in ${surface.id}.`);
		ids.add(page.id);
		patterns.add(pageShape(page.path));
		const parts: string[] = page.path.split('/');
		for (const previous of paths) {
			const other = previous.split('/');
			if (
				parts.length === other.length &&
				parts.filter((part) => part.startsWith(':')).length ===
					other.filter((part) => part.startsWith(':')).length &&
				parts.every(
					(part, i) =>
						part === other[i] ||
						part.startsWith(':') ||
						other[i]!.startsWith(':'),
				)
			)
				invalid(`ambiguous page patterns in ${surface.id}.`);
		}
		paths.push(page.path);
	}
	return Object.freeze({
		id: surface.id,
		pages: Object.freeze(
			surface.pages.map((page) =>
				Object.freeze({
					...page,
					entry: Object.freeze([...page.entry]) as unknown as WebPage['entry'],
					access: Object.freeze({ ...page.access }),
				}),
			),
		),
	});
}

function safeEntry(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+\/[a-zA-Z0-9_./-]+$/.test(value) &&
		!value.split('/').includes('..') &&
		!value.includes('//')
	);
}

function failure(status: number): Response {
	return new Response(
		status === 404
			? 'Not found'
			: status === 401
				? 'Authentication required'
				: status === 403
					? 'Forbidden'
					: 'Request failed',
		{ status, headers: { 'cache-control': 'no-store' } },
	);
}

export function createModuleWebRoutes(options: {
	readonly modules: readonly WebModuleComposition[];
	readonly mounts: readonly WebMount[];
	readonly applicationPath?: string;
	readonly resolveIdentity: (
		context: Context,
	) => WebIdentity | null | Promise<WebIdentity | null>;
}): readonly Route[] {
	const mounts = [...validateWebMounts(options.mounts)].sort(
		(a, b) => b.path.length - a.path.length,
	);
	const applicationPath = validateApplicationPath(
		options.applicationPath ?? '/app',
	);
	const reserved = [...RESERVED]
		.map((segment) => '/' + segment)
		.concat(applicationPath);
	const within = (path: string, prefix: string) =>
		path === prefix || path.startsWith(prefix + '/');
	const surfaces = new Map<string, ModuleWebSurface>();
	for (const module of options.modules) {
		for (const surface of module.web ?? []) {
			if (!module.moduleId || !MODULE_ID.test(module.moduleId))
				invalid('surface has no generated module owner.');
			const validated = defineWebSurface(surface);
			const key = `${module.moduleId}/${surface.id}`;
			if (surfaces.has(key)) invalid(`duplicate surface ${key}.`);
			surfaces.set(key, validated);
		}
	}
	const routes: Route[] = [];
	for (const site of mounts) {
		if (reserved.some((prefix) => within(site.path, prefix)))
			invalid('mount overlaps application routes.');
		const base = site.path === '/' ? '' : site.path;
		const surface = surfaces.get(`${site.moduleId}/${site.surfaceId}`);
		// A removed or disabled module must not fall through to a workspace route.
		if (site.enabled && surface) {
			for (const page of surface.pages) {
				if (
					site.path === '/' &&
					(reserved.some((prefix) => within(page.path, prefix)) ||
						mounts.some(
							(other) => other.path !== '/' && within(page.path, other.path),
						))
				)
					invalid('root page overlaps a reserved address.');
				const before: Middleware = async (context, next) => {
					if (
						site.path === '/' &&
						(reserved.some((prefix) => within(context.url.pathname, prefix)) ||
							mounts.some(
								(other) =>
									other.path !== '/' &&
									within(context.url.pathname, other.path),
							))
					)
						return failure(404);
					if (!['GET', 'HEAD'].includes(context.request.method))
						return failure(405);
					try {
						let identity: WebIdentity | null = null;
						if (page.access.kind !== 'public') {
							identity = await options.resolveIdentity(context);
							if (!identity) return failure(401);
							if (
								identity.tenantId !== site.tenantId ||
								(page.access.kind === 'permission' &&
									!identity.permissions.has(page.access.permission))
							)
								return failure(403);
						}
						const result = await page.load({
							site,
							identity,
							params: Object.freeze({ ...context.params }),
							url: new URL(context.request.url),
							signal: context.request.signal,
						});
						if (result instanceof Response) {
							// Redirect/fetch response headers can be immutable.
							const headers = new Headers(result.headers);
							headers.set('cache-control', 'no-store');
							headers.append('vary', 'Accept');
							if (context.request.method === 'HEAD')
								await result.body?.cancel();
							return new Response(
								context.request.method === 'HEAD' ? null : result.body,
								{
									status: result.status,
									statusText: result.statusText,
									headers,
								},
							);
						}
						const json = JSON.stringify(result);
						if (
							json === undefined ||
							new TextEncoder().encode(json).length > 1_048_576
						)
							throw new Error('Invalid page data.');
						// Parse to strip prototypes and give SSR and the browser identical DTOs.
						context.state.set(DATA_STATE, JSON.parse(json));
						if (context.request.headers.get('accept') === DATA_ACCEPT)
							return new Response(
								context.request.method === 'HEAD' ? null : json,
								{
									headers: {
										'content-type': 'application/json; charset=utf-8',
										'cache-control': 'no-store',
										vary: 'Accept',
									},
								},
							);
						if (context.request.method === 'HEAD')
							return new Response(null, {
								headers: {
									'content-type': 'text/html; charset=utf-8',
									'cache-control': 'no-store',
									vary: 'Accept',
								},
							});
						const response = await next();
						response.headers.set('cache-control', 'no-store');
						response.headers.append('vary', 'Accept');
						return webHtmlResponse(
							response,
							context.url.pathname + context.url.search,
							JSON.parse(json),
							context.state.get('octane.nonce') as string | undefined,
						);
					} catch {
						console.error(
							`[flowdular.web] page ${site.moduleId}/${surface.id}/${page.id} failed`,
						);
						return failure(500);
					}
				};
				routes.push(
					new RenderRoute({
						path: base + (page.path === '/' ? '' : page.path) || '/',
						entry: page.entry,
						...(page.layout ? { layout: page.layout } : {}),
						before: [before],
					}),
				);
			}
		}
		const fallback = (path: string) =>
			new ServerRoute({
				path,
				methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
				handler: () => failure(404),
			});
		if (
			!site.enabled ||
			!surface ||
			!surface.pages.some((page) => page.path === '/')
		)
			routes.push(fallback(site.path));
		/* A nested mount closes its own subtree. A root mount gets no catch-all:
		   it would claim the whole origin, and a matched server route pre-empts
		   the host layers that serve development transforms, built assets and
		   public files. Unmatched addresses reach those layers and 404 there. */
		if (base) routes.push(fallback(base + '/*unmatched'));
	}
	if (
		mounts.some((site) => site.path.startsWith('/sites/')) &&
		!mounts.some((site) => site.path === '/sites')
	) {
		routes.push(
			new ServerRoute({
				path: '/sites',
				methods: ['GET', 'HEAD'],
				handler: () => failure(404),
			}),
		);
		routes.push(
			new ServerRoute({
				path: '/sites/*unknownSite',
				methods: ['GET', 'HEAD'],
				handler: () => failure(404),
			}),
		);
	}
	assertRouteConflicts(routes);
	return routes;
}
