import { describe, expect, it } from 'vitest';
import {
	CORE_NAVIGATION,
	navigationForIdentity,
} from '../src/shell/navigation.ts';
import {
	shellLocationFromUrl,
	shellViewFromUrl,
	toggleNavigationGroup,
} from '../src/state.ts';

describe('shell route state', () => {
	it.each([
		['/', 'overview'],
		['/modules', 'modules'],
		['/specs?status=approved', 'specs'],
		['https://example.test/runs', 'runs'],
		['/catalog/items', 'catalog'],
	])('maps %s to %s', (url, expected) => {
		expect(shellViewFromUrl(url)).toBe(expected);
	});
});

describe('workspace-first locations', () => {
	const slugs = ['operations-demo', 'finance-demo'];

	it.each([
		['/operations-demo/parties', 'operations-demo', 'parties'],
		['/operations-demo', 'operations-demo', 'overview'],
		['/finance-demo/catalog?x=1', 'finance-demo', 'catalog'],
		['/parties', null, 'parties'],
		['/', null, 'overview'],
	])('resolves %s', (url, workspaceSlug, view) => {
		expect(shellLocationFromUrl(url, slugs)).toEqual({ workspaceSlug, view });
	});
});

describe('shell navigation groups', () => {
	it('toggles one group without changing the others', () => {
		expect(toggleNavigationGroup(['Development'], 'Administration')).toEqual([
			'Development',
			'Administration',
		]);
		expect(
			toggleNavigationGroup(
				['Development', 'Administration'],
				'Administration',
			),
		).toEqual(['Development']);
	});

	it('keeps development entries owner-only even if a member has a stale scope', () => {
		const development = [
			...CORE_NAVIGATION,
			{
				id: 'sandbox.navigation.access',
				viewId: 'sandbox',
				group: 'Development' as const,
				label: 'Sandbox',
				glyph: 'flask',
				description: 'Access and module sessions',
				scope: 'sandbox.access.manage',
				order: 50,
			},
		];
		const memberItems = navigationForIdentity(development, {
			role: 'member',
			scopes: ['system.workspace.access', 'sandbox.access.manage'],
		});
		expect(memberItems.map((item) => item.group)).toEqual(['Workspace']);

		const ownerItems = navigationForIdentity(development, {
			role: 'owner',
			scopes: ['system.workspace.access', 'sandbox.access.manage'],
		});
		expect(
			ownerItems.filter((item) => item.group === 'Development'),
		).toHaveLength(1);
	});
});
