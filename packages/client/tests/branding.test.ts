import {
	BRANDING_DATA_ELEMENT_ID,
	BRANDING_STATE_KEY,
	DEFAULT_APPLICATION_BRANDING,
} from '@flowdular/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import {
	applicationBranding,
	configureApplicationBranding,
	configureBrandingFromPage,
} from '../src/branding.ts';

const ACME = {
	...DEFAULT_APPLICATION_BRANDING,
	appName: 'Acme Operations',
	logoUrl: '/brand/acme.svg',
};

afterEach(() => {
	vi.unstubAllGlobals();
	configureApplicationBranding(null);
});

it('reads the branding from page state on a server render', () => {
	configureBrandingFromPage({ state: new Map([[BRANDING_STATE_KEY, ACME]]) });
	expect(applicationBranding()).toEqual(ACME);
});

it('reads the branding from the data block on hydration', () => {
	vi.stubGlobal('document', {
		getElementById: (id: string) =>
			id === BRANDING_DATA_ELEMENT_ID
				? { textContent: JSON.stringify(ACME) }
				: null,
	});
	configureBrandingFromPage(undefined);
	expect(applicationBranding().appName).toBe('Acme Operations');
});

it('keeps the product defaults without either source', () => {
	vi.stubGlobal('document', { getElementById: () => null });
	configureBrandingFromPage(undefined);
	expect(applicationBranding()).toEqual(DEFAULT_APPLICATION_BRANDING);
});

/* The block is same-origin, but it is still markup in a document: a value
   that does not fit its declaration decorates nothing. */
it('drops a transported value the declaration would refuse', () => {
	vi.stubGlobal('document', {
		getElementById: () => ({
			textContent: JSON.stringify({
				...ACME,
				logoUrl: 'javascript:alert(1)',
			}),
		}),
	});
	configureBrandingFromPage(undefined);
	expect(applicationBranding().appName).toBe('Acme Operations');
	expect(applicationBranding().logoUrl).toBe('');
});

it('keeps the defaults when the data block is not JSON', () => {
	vi.stubGlobal('document', {
		getElementById: () => ({ textContent: 'not json' }),
	});
	configureBrandingFromPage(undefined);
	expect(applicationBranding()).toEqual(DEFAULT_APPLICATION_BRANDING);
});
