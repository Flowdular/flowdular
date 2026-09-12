import { describe, expect, it, vi } from 'vitest';
import { Tabs } from '../src/components/Tabs.tsrx';
import type { TabItem } from '../src/components/tabs.ts';
import { mount, run } from './dom.ts';

const ITEMS: readonly TabItem[] = [
	{ id: 'members', label: 'Members' },
	{ id: 'roles', label: 'Roles', disabled: true },
	{ id: 'audit', label: 'Audit' },
];

function tabs(container: HTMLElement): readonly HTMLButtonElement[] {
	return Array.from(container.querySelectorAll('[role="tab"]'));
}

function inTabOrder(container: HTMLElement): readonly string[] {
	return tabs(container).filter((tab) => tab.tabIndex === 0).map(
		(tab) => tab.id,
	);
}

describe('Tabs', () => {
	it(
		'wires every tab to the caller panel and selects the active one',
		async () => {
			const mounted = await mount(
				<Tabs
					id="people"
					items={ITEMS}
					active="members"
					label="People sections"
					onChange={() => {}}
				/>,
			);
			const list = mounted.container.querySelector('[role="tablist"]');
			expect(list?.getAttribute('aria-label')).toBe('People sections');
			expect(tabs(mounted.container).map((tab) => tab.id)).toEqual([
				'people-tab-members',
				'people-tab-roles',
				'people-tab-audit',
			]);
			expect(
				tabs(mounted.container).map((tab) => tab.getAttribute('aria-controls')),
			).toEqual([
				'people-panel-members',
				'people-panel-roles',
				'people-panel-audit',
			]);
			expect(
				tabs(mounted.container).map((tab) => tab.getAttribute('aria-selected')),
			).toEqual(['true', 'false', 'false']);
			expect(tabs(mounted.container)[1]?.disabled).toBe(true);
			expect(inTabOrder(mounted.container)).toEqual(['people-tab-members']);
			mounted.unmount();
		},
	);

	it('reports the tab a click and an arrow key select', async () => {
		const onChange = vi.fn();
		const mounted = await mount(
			<Tabs
				id="people"
				items={ITEMS}
				active="members"
				label="People sections"
				onChange={onChange}
			/>,
		);
		await run(() => tabs(mounted.container)[2]?.click());
		expect(onChange).toHaveBeenLastCalledWith('audit');
		await run(() => {
			tabs(mounted.container)[0]?.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
			);
		});
		expect(onChange).toHaveBeenLastCalledWith('audit');
		mounted.unmount();
	});

	it(
		'keeps one tab in the tab order when active names no enabled tab',
		async () => {
			const disabledActive = await mount(
				<Tabs
					id="people"
					items={ITEMS}
					active="roles"
					label="People sections"
					onChange={() => {}}
				/>,
			);
			expect(inTabOrder(disabledActive.container)).toEqual([
				'people-tab-members',
			]);
			expect(
				tabs(disabledActive.container).map(
					(tab) => tab.getAttribute('aria-selected'),
				),
			).toEqual(['true', 'false', 'false']);
			disabledActive.unmount();

			const goneActive = await mount(
				<Tabs
					id="people"
					items={ITEMS}
					active="archived"
					label="People sections"
					onChange={() => {}}
				/>,
			);
			expect(inTabOrder(goneActive.container)).toEqual(['people-tab-members']);
			goneActive.unmount();
		},
	);
});
