import { viewHref } from '../src/shell/navigation.ts';
import { afterEach, expect, it, vi } from 'vitest';
import {
	applicationPath,
	configureApplicationFromPage,
	configureApplicationRouting,
} from '../src/routing.ts';
import { shellLocationFromUrl } from '../src/state.ts';

afterEach(() => {
	vi.unstubAllGlobals();
	configureApplicationRouting('/app');
});
it('uses the runtime dashboard path for SSR, hydration and workspace parsing', () => {
	configureApplicationFromPage(
		{ state: new Map([['flowdular.application.path', '/backoffice']]) },
		'/app',
	);
	expect(applicationPath()).toBe('/backoffice');
	expect(viewHref('settings', 'acme')).toBe('/backoffice/acme/settings');
	expect(shellLocationFromUrl('/backoffice/acme/settings', ['acme']).view).toBe(
		'settings',
	);
	configureApplicationRouting('/app');
	vi.stubGlobal('document', {
		getElementById: () => ({ textContent: '"/backoffice"' }),
	});
	configureApplicationFromPage(undefined, '/app');
	expect(applicationPath()).toBe('/backoffice');
});
it('keeps the generated default when no runtime data exists', () => {
	configureApplicationFromPage(undefined, '/office');
	expect(applicationPath()).toBe('/office');
});
