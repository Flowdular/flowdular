import { createContext, createRouter } from '@octanejs/app-core';
import {
	BRANDING_STATE_KEY,
	DEFAULT_APPLICATION_BRANDING,
	type ApplicationBranding,
} from '@flowdular/contracts';
import { afterEach, expect, it } from 'vitest';
import {
	createApplicationRoutes,
	createSecurityHeadersMiddleware,
	currentApplicationBranding,
	installApplicationBranding,
	PRODUCTION_CONTENT_SECURITY_POLICY,
} from '../src/index.ts';

const ACME: ApplicationBranding = {
	appName: 'Acme Operations',
	documentTitle: 'Acme Backoffice',
	description: 'Operations for Acme.',
	ogImageUrl: 'https://images.example.test/acme.png',
	faviconUrl: 'https://cdn.example.test/acme.svg',
	themeColor: '#0B5FFF',
	logoUrl: '/brand/acme.svg',
};

afterEach(() => {
	installApplicationBranding(null);
});

async function renderApplication(): Promise<{
	readonly html: string;
	readonly state: unknown;
}> {
	const routes = createApplicationRoutes({
		path: '/app',
		entry: ['App', '/src/App.tsrx'],
		publicRoot: false,
	});
	const match = createRouter([...routes]).match('GET', '/app/acme/settings')!;
	if (match.route.type !== 'render') throw new Error('Missing application');
	const context = createContext(
		new Request('https://erp.example.test/app/acme/settings'),
		match.params,
	);
	const response = await match.route.before[0]!(
		context,
		async () =>
			new Response('<html><head></head><body>Shell</body></html>', {
				headers: { 'content-type': 'text/html' },
			}),
	);
	return {
		html: await response.text(),
		state: context.state.get(BRANDING_STATE_KEY),
	};
}

/* SYSTEM-BRANDING-ANONYMOUS: the document carries the values, so a visitor
   with no session and a crawler reading the same response both see them. */
it('hands the render and the browser the same branding', async () => {
	installApplicationBranding(() => ACME);
	const { html, state } = await renderApplication();
	expect(state).toEqual(ACME);
	expect(html).toContain(
		'id="flowdular-branding-data" type="application/json">',
	);
	expect(html).toContain('"appName":"Acme Operations"');
	expect(html).toContain('--flowdular-brand:"Acme Operations"');
});

it('serves the product defaults when no module installed a provider', async () => {
	const { html, state } = await renderApplication();
	expect(state).toEqual(DEFAULT_APPLICATION_BRANDING);
	expect(html).toContain('"appName":"Flowdular"');
});

it('keeps the document when the provider fails', () => {
	installApplicationBranding(() => {
		throw new Error('settings are not primed');
	});
	expect(currentApplicationBranding()).toEqual(DEFAULT_APPLICATION_BRANDING);
});

/* A stored value that no longer fits its declaration decorates nothing; the
   document is still served, with the product's own value in its place. */
it('drops a value the declaration would refuse', () => {
	installApplicationBranding(
		() =>
			({
				...DEFAULT_APPLICATION_BRANDING,
				logoUrl: 'javascript:alert(1)',
			}) as ApplicationBranding,
	);
	expect(currentApplicationBranding().logoUrl).toBe('');
});

it('names the branding image origins in the policy it serves', async () => {
	installApplicationBranding(() => ACME);
	const middleware = createSecurityHeadersMiddleware({
		strictTransportSecurity: true,
		contentSecurityPolicy: PRODUCTION_CONTENT_SECURITY_POLICY,
		reportOnly: false,
	});
	const response = await middleware(
		createContext(new Request('https://erp.example.test/app'), {}),
		async () =>
			new Response('{}', { headers: { 'content-type': 'text/json' } }),
	);
	const policy = response.headers.get('content-security-policy')!;
	expect(policy).toContain(
		"img-src 'self' data: https://cdn.example.test https://images.example.test",
	);
	/* Nothing else moves: the widening is one directive and one origin set. */
	expect(policy).toContain("connect-src 'self'");
});

it('leaves the policy alone for a deployment serving its own images', async () => {
	const middleware = createSecurityHeadersMiddleware({
		strictTransportSecurity: true,
		contentSecurityPolicy: PRODUCTION_CONTENT_SECURITY_POLICY,
		reportOnly: false,
	});
	const response = await middleware(
		createContext(new Request('https://erp.example.test/app'), {}),
		async () =>
			new Response('{}', { headers: { 'content-type': 'text/json' } }),
	);
	expect(response.headers.get('content-security-policy')).toContain(
		"img-src 'self' data:; connect-src 'self'",
	);
});
