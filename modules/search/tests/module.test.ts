import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { moduleDefinition } from '../src/index.ts';
import { SEARCH_PERMISSIONS } from '../src/acl/permissions.ts';
import { SEARCH_PROVIDERS_CAPABILITY } from '../src/domain/providers.ts';
import * as clientNavigation from '../src/client/navigation.ts';
import {
	searchCommandContribution,
	searchNavigation,
	workspaceRouteHref,
} from '../src/client/navigation.ts';

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));

/* Everything outside tab, newline and carriage return. A raw control byte
   reads as an empty string in a diff and in a review, so a literal that
   matters becomes invisible. */
function controlByteAt(bytes: Buffer): number {
	return bytes.findIndex(
		(byte) => byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d,
	);
}

describe('search.core', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('search.core');
	});

	it('declares the capability it registers in its manifest', () => {
		expect(moduleDefinition.manifest.provides).toContain(
			SEARCH_PROVIDERS_CAPABILITY,
		);
	});

	it('puts the screen in Workspace', () => {
		expect(searchNavigation[0]?.group).toBe('Workspace');
		expect(searchNavigation[0]?.viewId).toBe('search');
	});

	/* The shell's own topbar button already opens the palette, so a widget in
	   the same slot was a second control doing the same thing. */
	it('contributes no topbar widget of its own', () => {
		expect(
			Object.entries(clientNavigation).filter(
				([, value]) =>
					typeof value === 'object' && value !== null && 'slot' in value,
			),
		).toEqual([]);
	});

	it('gates the palette contribution on the search permission', () => {
		expect(searchCommandContribution.scope).toBe(SEARCH_PERMISSIONS.read);
	});

	it('writes no control byte into a source file', () => {
		for (const entry of readdirSync(SOURCE_ROOT, {
			recursive: true,
			withFileTypes: true,
		})) {
			if (!entry.isFile()) continue;
			const path = `${entry.parentPath}/${entry.name}`;
			expect([
				path.slice(SOURCE_ROOT.length),
				controlByteAt(readFileSync(path)),
			]).toEqual([path.slice(SOURCE_ROOT.length), -1]);
		}
	});
});

describe('workspace route hrefs', () => {
	it('keeps the workspace slug the member is in', () => {
		expect(
			workspaceRouteHref('/users?member=a1', '/app/acme/search', '/app'),
		).toBe('/app/acme/users?member=a1');
	});

	it('works on a workspace URL without a slug', () => {
		expect(workspaceRouteHref('/users', '/app/search', '/app')).toBe(
			'/app/users',
		);
	});

	/* A route is module-supplied, so anything that could leave the application
	   collapses to the workspace root rather than being turned into an href. */
	it('refuses a protocol-relative route', () => {
		expect(
			workspaceRouteHref('//evil.example', '/app/acme/search', '/app'),
		).toBe('/app/acme/');
	});
});
