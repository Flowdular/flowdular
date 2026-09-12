import { describe, expect, it } from 'vitest';
import { nextTabId, type TabItem } from '../src/components/tabs.ts';

const TABS: readonly TabItem[] = [
	{ id: 'members', label: 'Members' },
	{ id: 'roles', label: 'Roles', disabled: true },
	{ id: 'audit', label: 'Audit' },
];

describe('tablist keyboard movement', () => {
	it('steps over a disabled tab in both directions', () => {
		expect(nextTabId(TABS, 'members', 'ArrowRight')).toBe('audit');
		expect(nextTabId(TABS, 'audit', 'ArrowLeft')).toBe('members');
	});

	it('wraps at both ends', () => {
		expect(nextTabId(TABS, 'audit', 'ArrowRight')).toBe('members');
		expect(nextTabId(TABS, 'members', 'ArrowLeft')).toBe('audit');
	});

	it('jumps to the outer enabled tab with Home and End', () => {
		expect(nextTabId(TABS, 'audit', 'Home')).toBe('members');
		expect(nextTabId(TABS, 'members', 'End')).toBe('audit');
		expect(
			nextTabId(
				[
					{ id: 'a', label: 'A', disabled: true },
					{ id: 'b', label: 'B' },
				],
				'b',
				'Home',
			),
		).toBe('b');
	});

	it('leaves keys that belong to the page alone', () => {
		expect(nextTabId(TABS, 'members', 'Enter')).toBe('');
		expect(nextTabId(TABS, 'members', 'ArrowDown')).toBe('');
		expect(nextTabId(TABS, 'members', 'a')).toBe('');
	});

	it('answers nothing when no tab can take focus', () => {
		expect(nextTabId([], 'members', 'ArrowRight')).toBe('');
		expect(
			nextTabId([{ id: 'a', label: 'A', disabled: true }], 'a', 'ArrowRight'),
		).toBe('');
		expect(
			nextTabId([{ id: 'a', label: 'A', disabled: true }], 'a', 'End'),
		).toBe('');
	});

	it('starts from the first tab when the active id is unknown', () => {
		expect(nextTabId(TABS, 'gone', 'ArrowRight')).toBe('audit');
	});
});
