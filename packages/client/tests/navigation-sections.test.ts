import { describe, expect, it } from 'vitest';
import type { NavigationContribution } from '../src/contributions.ts';
import { navigationSections } from '../src/shell/navigation.ts';

function item(
	id: string,
	section?: NavigationContribution['section'],
): NavigationContribution {
	return {
		id,
		viewId: id,
		group: 'Administration',
		label: id,
		glyph: 'settings',
		description: '',
		scope: 'x',
		order: 0,
		...(section === undefined ? {} : { section }),
	};
}

describe('navigationSections', () => {
	it('orders sections by the fixed list and keeps unsectioned items last', () => {
		const blocks = navigationSections([
			item('reports', 'platform'),
			item('legacy'),
			item('users', 'people'),
			item('webhooks', 'integrations'),
			item('roles', 'people'),
		]);
		expect(
			blocks.map((block) => [
				block.section,
				block.items.map((entry) => entry.id),
			]),
		).toEqual([
			['people', ['users', 'roles']],
			['integrations', ['webhooks']],
			['platform', ['reports']],
			[null, ['legacy']],
		]);
	});

	it('answers one unlabelled block when nothing declares a section', () => {
		const blocks = navigationSections([item('a'), item('b')]);
		expect(blocks).toEqual([{ section: null, items: [item('a'), item('b')] }]);
	});

	it('answers nothing for no items', () => {
		expect(navigationSections([])).toEqual([]);
	});
});
