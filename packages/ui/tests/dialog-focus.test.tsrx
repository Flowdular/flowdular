import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/components/ConfirmDialog.tsrx';
import { Drawer } from '../src/components/Drawer.tsrx';
import { mount, run } from './dom.ts';

function drawer(open: boolean, onClose: () => void, autoFocus = false) {
	return <div>
		<button class="opener" type="button">Open</button>
		<Drawer open={open} title="New token" onClose={onClose}>
			<div class="ui-drawer__body">
				<input class="first" autoFocus={autoFocus} />
				<button class="last" type="button">Save</button>
			</div>
		</Drawer>
	</div>;
}

function dialog(open: boolean, onCancel: () => void) {
	return <div>
		<button class="opener" type="button">Revoke</button>
		<ConfirmDialog
			open={open}
			title="Revoke the token"
			onConfirm={() => {}}
			onCancel={onCancel}
		>Nothing authenticates with it afterwards.</ConfirmDialog>
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

describe('Drawer focus', () => {
	it('moves focus into the panel and back to the opener on close', async () => {
		const onClose = vi.fn();
		const mounted = await mount(drawer(false, onClose));
		const opener = mounted.container.querySelector<HTMLButtonElement>(
			'.opener',
		);
		opener?.focus();
		expect(active()).toBe('opener');

		await mounted.render(drawer(true, onClose));
		expect(active()).toBe('ui-drawer__close');

		await mounted.render(drawer(false, onClose));
		expect(active()).toBe('opener');
		mounted.unmount();
	});

	it('leaves focus where an autoFocus control took it', async () => {
		const mounted = await mount(drawer(false, () => {}, true));
		mounted.container.querySelector<HTMLButtonElement>('.opener')?.focus();
		await mounted.render(drawer(true, () => {}, true));
		expect(active()).toBe('first');
		mounted.unmount();
	});

	it('wraps Tab at both ends of the panel', async () => {
		const mounted = await mount(drawer(false, () => {}));
		await mounted.render(drawer(true, () => {}));

		mounted.container.querySelector<HTMLButtonElement>('.last')?.focus();
		await run(() => press('Tab'));
		expect(active()).toBe('ui-drawer__close');

		await run(() => press('Tab', true));
		expect(active()).toBe('last');
		mounted.unmount();
	});

	it('pulls focus back in when it left the panel', async () => {
		const mounted = await mount(drawer(false, () => {}));
		await mounted.render(drawer(true, () => {}));

		mounted.container.querySelector<HTMLButtonElement>('.opener')?.focus();
		expect(active()).toBe('opener');
		await run(() => press('Tab'));
		expect(active()).toBe('ui-drawer__close');
		mounted.unmount();
	});

	it('closes on Escape', async () => {
		const onClose = vi.fn();
		const mounted = await mount(drawer(false, onClose));
		await mounted.render(drawer(true, onClose));
		await run(() => press('Escape'));
		expect(onClose).toHaveBeenCalled();
		mounted.unmount();
	});

	/* Tab must not walk the workspace behind the panel, so a panel with nothing
   to focus still holds the keystroke. */
	it('holds Tab on a panel with no focusable child', async () => {
		const empty = (open: boolean) => <div>
			<button class="opener" type="button">Open</button>
			<Drawer open={open} title="Reading" onClose={() => {}}>
				<div class="ui-drawer__body">Nothing to edit.</div>
			</Drawer>
		</div>;
		const mounted = await mount(empty(false));
		await mounted.render(empty(true));
		mounted.container.querySelector<HTMLButtonElement>(
			'.ui-drawer__close',
		)?.remove();
		await run(() => press('Tab'));
		expect(active()).toBe('ui-drawer__panel');
		mounted.unmount();
	});
});

describe('ConfirmDialog focus', () => {
	it(
		'moves focus into the dialog and back to the opener on close',
		async () => {
			const mounted = await mount(dialog(false, () => {}));
			mounted.container.querySelector<HTMLButtonElement>('.opener')?.focus();

			await mounted.render(dialog(true, () => {}));
			const focused = document.activeElement as HTMLElement | null;
			expect(focused?.textContent).toBe('Cancel');

			await mounted.render(dialog(false, () => {}));
			expect(active()).toBe('opener');
			mounted.unmount();
		},
	);

	it('wraps Tab between cancel and confirm', async () => {
		const mounted = await mount(dialog(false, () => {}));
		await mounted.render(dialog(true, () => {}));
		const buttons = [
			...mounted.container.querySelectorAll<HTMLButtonElement>(
				'.ui-dialog__actions button',
			),
		];
		buttons[buttons.length - 1]?.focus();
		await run(() => press('Tab'));
		expect(document.activeElement?.textContent).toBe('Cancel');

		await run(() => press('Tab', true));
		expect(document.activeElement?.textContent).toBe('Confirm');
		mounted.unmount();
	});
});
