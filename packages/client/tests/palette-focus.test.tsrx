import { act, createRoot, setIsOctaneActEnvironment } from 'octane';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../src/shell/CommandPalette.tsrx';

setIsOctaneActEnvironment(true);

const ITEMS = [
	{
		id: 'users',
		viewId: 'users',
		label: 'Users',
		description: 'Members of the workspace',
		group: 'workspace',
		glyph: 'users',
	},
	{
		id: 'reports',
		viewId: 'reports',
		label: 'Reports',
		description: 'Numbers',
		group: 'workspace',
		glyph: 'chart',
	},
] as never;

function host(open: boolean, onClose = () => {}) {
	return <div>
		<button class="opener" type="button">Search</button>
		<button class="behind" type="button">Workspace</button>
		{open
			? <CommandPalette
					items={ITEMS}
					searches={[]}
					query=""
					onQuery={() => {}}
					onNavigate={() => {}}
					onOpenHit={() => {}}
					onClose={onClose}
				/>
			: null}
	</div>;
}

function press(key: string, shiftKey = false): void {
	(document.activeElement ?? document.body).dispatchEvent(
		new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }),
	);
}

function active(): string {
	return (document.activeElement as HTMLElement | null)?.className ?? '';
}

let teardown: (() => void) | undefined;

afterEach(() => {
	teardown?.();
	teardown = undefined;
});

async function mountHost() {
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	const render = (open: boolean, onClose?: () => void) => act(() => {
		root.render(host(open, onClose) as never);
	});
	await render(false);
	teardown = () => {
		root.unmount();
		container.remove();
	};
	container.querySelector<HTMLButtonElement>('.opener')?.focus();
	return { container, render };
}

describe('command palette focus', () => {
	it('takes focus on open and holds Tab on the input', async () => {
		const { render } = await mountHost();
		await render(true);
		expect(document.activeElement?.getAttribute('role')).toBe('combobox');

		await act(() => press('Tab'));
		expect(document.activeElement?.getAttribute('role')).toBe('combobox');
		await act(() => press('Tab', true));
		expect(document.activeElement?.getAttribute('role')).toBe('combobox');
	});

	/* The options are reached with the arrow keys, so Tab never lands on one
   and never leaves for the workspace behind the overlay. */
	it('pulls focus back in when it left the dialog', async () => {
		const { container, render } = await mountHost();
		await render(true);
		container.querySelector<HTMLButtonElement>('.behind')?.focus();
		expect(active()).toBe('behind');
		await act(() => press('Tab'));
		expect(document.activeElement?.getAttribute('role')).toBe('combobox');
	});

	it('returns focus to the opener on close', async () => {
		const onClose = vi.fn();
		const { render } = await mountHost();
		await render(true, onClose);
		expect(active()).not.toBe('opener');

		await render(false, onClose);
		expect(active()).toBe('opener');
		await act(() => press('Tab'));
		expect(active()).toBe('opener');
	});
});
