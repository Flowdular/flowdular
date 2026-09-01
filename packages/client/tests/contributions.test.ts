import { describe, expect, it } from 'vitest';
import { createClientContributionRegistry } from '../src/contributions.ts';

const render = () => 'content';

describe('client contribution registry', () => {
	it('sorts trusted module contributions deterministically', () => {
		const registry = createClientContributionRegistry([
			{
				moduleId: 'catalog.core',
				views: [{ id: 'catalog', render }],
				navigation: [
					{
						id: 'catalog.navigation',
						viewId: 'catalog',
						group: 'Operations',
						label: 'Catalog',
						glyph: 'CA',
						description: 'Products and services',
						scope: 'catalog.items.read',
						order: 30,
					},
				],
				widgets: [
					{
						id: 'catalog.metric',
						slot: 'dashboard.metrics',
						scope: 'catalog.items.read',
						order: 20,
						render,
					},
				],
			},
		]);

		expect(registry.navigation.map((item) => item.id)).toEqual([
			'catalog.navigation',
		]);
		expect(registry.widgets.map((item) => item.id)).toEqual(['catalog.metric']);
	});

	it('rejects a navigation item without a registered view', () => {
		expect(() =>
			createClientContributionRegistry([
				{
					moduleId: 'broken.core',
					navigation: [
						{
							id: 'broken.navigation',
							viewId: 'missing',
							group: 'Operations',
							label: 'Broken',
							glyph: 'BR',
							description: 'Invalid contribution',
							scope: 'broken.read',
							order: 10,
						},
					],
				},
			]),
		).toThrow('targets unknown view missing');
	});

	it('accepts multiple navigation entries and views from one module', () => {
		const registry = createClientContributionRegistry([
			{
				moduleId: 'users.core',
				views: [
					{ id: 'users', render },
					{ id: 'roles', render },
				],
				navigation: [
					{
						id: 'users.navigation',
						viewId: 'users',
						group: 'Administration',
						label: 'Users',
						glyph: 'US',
						description: 'Accounts',
						scope: 'users.members.read',
						order: 5,
					},
					{
						id: 'users.roles.navigation',
						viewId: 'roles',
						group: 'Administration',
						label: 'Roles',
						glyph: 'RO',
						description: 'Permissions',
						scope: 'users.members.read',
						order: 10,
					},
				],
			},
		]);

		expect(registry.views.map((view) => view.id)).toEqual(['roles', 'users']);
		expect(registry.navigation.map((item) => item.viewId)).toEqual([
			'users',
			'roles',
		]);
	});

	it('keeps account menu views out of the sidebar navigation', () => {
		const registry = createClientContributionRegistry([
			{
				moduleId: 'profile.core',
				views: [{ id: 'profile', render }],
				accountMenu: [
					{
						id: 'profile.account-menu',
						viewId: 'profile',
						label: 'Profile',
						description: 'Display name and password',
						glyph: 'users',
						scope: 'profile.self.manage',
						order: 10,
					},
				],
			},
		]);

		expect(registry.navigation).toEqual([]);
		expect(registry.accountMenu.map((item) => item.viewId)).toEqual([
			'profile',
		]);
	});

	it('rejects an account menu item without a registered view', () => {
		expect(() =>
			createClientContributionRegistry([
				{
					moduleId: 'broken.core',
					accountMenu: [
						{
							id: 'broken.account-menu',
							viewId: 'missing',
							label: 'Broken',
							description: 'Invalid contribution',
							glyph: 'users',
							scope: 'broken.read',
							order: 10,
						},
					],
				},
			]),
		).toThrow(
			'Account menu contribution broken.account-menu targets unknown view missing',
		);
	});

	it('rejects duplicate contribution identifiers', () => {
		expect(() =>
			createClientContributionRegistry([
				{
					moduleId: 'one.core',
					views: [{ id: 'shared', render }],
				},
				{
					moduleId: 'two.core',
					views: [{ id: 'shared', render }],
				},
			]),
		).toThrow('Duplicate client contribution view id: shared');
	});
});
