import { viewHref } from '../src/shell/navigation.ts';
import { afterEach, expect, it, vi } from 'vitest';
import {
	applicationPath,
	configureApplicationFromPage,
	configureApplicationRouting,
	workspaceViewHref,
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
/* A module widget passes neither, so the installation path and the open address
   are read at the call: a server render has no address and lands on the
   slugless form the shell resolves against the open workspace. */
it('defaults a module link to the installation path and the open address', () => {
	configureApplicationRouting('/backoffice');
	expect(workspaceViewHref('audit')).toBe('/backoffice/audit');
	vi.stubGlobal('window', {
		location: { pathname: '/backoffice/northwind/modules' },
	});
	expect(workspaceViewHref('audit')).toBe('/backoffice/northwind/audit');
});
