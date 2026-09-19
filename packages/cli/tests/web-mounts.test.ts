import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Workspace } from '../src/workspace.ts';
import { currentMounts, planMount, planUnmount } from '../src/web-mounts.ts';

const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace(config: Record<string, unknown>): Workspace {
	const root = mkdtempSync(join(tmpdir(), 'flowdular-web-mounts-'));
	roots.push(root);
	const configPath = join(root, 'flowdular.json');
	writeFileSync(configPath, JSON.stringify(config, null, 2));
	return { root, configPath, config };
}

const enabled = {
	modules: { enabled: ['system.core', 'auth.core', 'blog.core'] },
};

const request = {
	moduleId: 'blog.core',
	surfaceId: 'site',
	path: '/',
	tenantId: 'tenant-a',
};

describe('planning a mount', () => {
	it('answers the mount a module site needs, named after the module', () => {
		const report = planMount(workspace(enabled), request);
		expect(report.mount).toEqual({
			id: 'blog',
			moduleId: 'blog.core',
			surfaceId: 'site',
			path: '/',
			tenantId: 'tenant-a',
		});
		expect(report.applied).toBe(false);
		expect(report.replaced).toBe(false);
	});

	it('refuses a module this workspace has not enabled, and says what to run', () => {
		expect(() =>
			planMount(workspace({ modules: { enabled: ['system.core'] } }), request),
		).toThrow(/not enabled.*flowdular module enable blog\.core --apply/s);
	});

	it('refuses an address the application answers on', () => {
		for (const path of ['/api', '/auth', '/app', '/sign-in']) {
			expect(() => planMount(workspace(enabled), { ...request, path })).toThrow(
				/cannot take it/,
			);
		}
	});

	it('refuses an address the configured shell answers on', () => {
		expect(() =>
			planMount(
				workspace({ ...enabled, application: { path: '/backoffice' } }),
				{ ...request, path: '/backoffice/pages' },
			),
		).toThrow(/\/backoffice; a site cannot take it/);
	});

	it('refuses an address that overlaps a site already mounted', () => {
		const existing = workspace({
			...enabled,
			web: {
				mounts: [
					{
						id: 'docs',
						moduleId: 'documents.core',
						surfaceId: 'site',
						path: '/library',
						tenantId: 'tenant-a',
					},
				],
			},
		});
		expect(() =>
			planMount(existing, { ...request, path: '/library/posts' }),
		).toThrow(/docs already answers on \/library/);
		expect(() =>
			planMount(existing, { ...request, path: '/journal' }),
		).not.toThrow();
	});

	it('refuses a path or an id the platform would not accept', () => {
		expect(() =>
			planMount(workspace(enabled), { ...request, path: 'blog' }),
		).toThrow(/Invalid mount path/);
		expect(() =>
			planMount(workspace(enabled), { ...request, path: '/Blog' }),
		).toThrow(/Invalid mount path/);
		expect(() =>
			planMount(workspace(enabled), { ...request, id: 'Blog' }),
		).toThrow(/Invalid mount id/);
	});

	it('demands the workspace the pages read, because a mount carries none', () => {
		expect(() =>
			planMount(workspace(enabled), { ...request, tenantId: '  ' }),
		).toThrow(/--tenant/);
	});

	it('replaces the mount of the same id rather than serving two addresses', () => {
		const existing = workspace({
			...enabled,
			web: {
				mounts: [
					{
						id: 'blog',
						moduleId: 'blog.core',
						surfaceId: 'site',
						path: '/journal',
						tenantId: 'tenant-a',
					},
				],
			},
		});
		const report = planMount(existing, request);
		expect(report.replaced).toBe(true);
		expect(report.mounts).toHaveLength(1);
		expect(report.mounts[0]?.path).toBe('/');
	});
});

describe('planning an unmount', () => {
	it('removes the named mount and leaves the others', () => {
		const existing = workspace({
			...enabled,
			web: {
				mounts: [
					{
						id: 'blog',
						moduleId: 'blog.core',
						surfaceId: 'site',
						path: '/',
						tenantId: 'tenant-a',
					},
					{
						id: 'docs',
						moduleId: 'documents.core',
						surfaceId: 'site',
						path: '/library',
						tenantId: 'tenant-a',
					},
				],
			},
		});
		const report = planUnmount(existing, 'blog');
		expect(report.removed.path).toBe('/');
		expect(report.mounts.map((mount) => mount.id)).toEqual(['docs']);
	});

	it('refuses an id nothing is mounted under', () => {
		expect(() => planUnmount(workspace(enabled), 'blog')).toThrow(
			/No mount with id blog/,
		);
	});
});

describe('reading the mounts', () => {
	it('answers an empty list for a workspace that serves no site', () => {
		expect(currentMounts(workspace(enabled))).toEqual([]);
	});
});
