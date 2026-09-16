import { describe, expect, it, vi } from 'vitest';
import {
	SortableList,
	type SortableAnnouncement,
	type SortableListItem,
} from '../src/components/SortableList.tsrx';
import { mount, run, text } from './dom.ts';

const ITEMS: readonly SortableListItem[] = [
	{ id: 'a', label: 'Alpha' },
	{ id: 'b', label: 'Bravo' },
	{ id: 'c', label: 'Charlie' },
	{ id: 'd', label: 'Delta' },
];

function announce(event: SortableAnnouncement): string {
	return `${event.kind} ${event.label} ${event.position} of ${event.total}`;
}

function list(onReorder: (ids: readonly string[]) => void, disabled = false) {
	return <SortableList
		id="order"
		label="Adapter order"
		items={ITEMS}
		onReorder={onReorder}
		handleLabel={(item) => 'Move ' + item.label}
		instructions="Press Space to pick up."
		announce={announce}
		renderItem={(item) => <span class="label">{item.label}</span>}
		disabled={disabled}
	/>;
}

function handles(container: HTMLElement): HTMLButtonElement[] {
	return Array.from(container.querySelectorAll('.ui-sortable__handle'));
}

function labels(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('.label')).map(
		(node) => text(node),
	);
}

function live(container: HTMLElement): string {
	return text(container.querySelector('[role="status"]'));
}

function press(target: Element, key: string): void {
	target.dispatchEvent(
		new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
	);
}

function pointer(
	target: Element,
	type: string,
	clientY: number,
	pointerId = 1,
): void {
	target.dispatchEvent(
		new PointerEvent(type, {
			pointerId,
			clientY,
			button: 0,
			bubbles: true,
			cancelable: true,
		}),
	);
}

function stubRows(container: HTMLElement): void {
	const rows = container.querySelectorAll<HTMLElement>('.ui-sortable__item');
	rows.forEach((row, index) => {
		const rect = new DOMRect(0, index * 40, 100, 40);
		row.getBoundingClientRect = () => rect;
	});
}

function withClass(container: HTMLElement, name: string): string[] {
	return Array.from(container.querySelectorAll('.' + name)).map(
		(node) => text(node.querySelector('.label')),
	);
}

describe('SortableList', () => {
	it(
		'names every grip and keeps the live region in the DOM while empty',
		async () => {
			const mounted = await mount(list(() => {}));
			const region = mounted.container.querySelector('[role="status"]');
			expect(region?.getAttribute('aria-live')).toBe('polite');
			expect(live(mounted.container)).toBe('');
			expect(
				mounted.container.querySelector('ol')?.getAttribute('aria-label'),
			).toBe('Adapter order');
			const grips = handles(mounted.container);
			expect(grips.map((grip) => grip.getAttribute('aria-label'))).toEqual([
				'Move Alpha',
				'Move Bravo',
				'Move Charlie',
				'Move Delta',
			]);
			const described = grips[0]?.getAttribute('aria-describedby') ?? '';
			expect(text(document.getElementById(described))).toBe(
				'Press Space to pick up.',
			);
			mounted.unmount();
		},
	);

	it(
		'picks up with Space, moves with the arrows and drops with Space',
		async () => {
			const onReorder = vi.fn();
			const mounted = await mount(list(onReorder));
			const grip = handles(mounted.container)[0]!;
			grip.focus();

			await run(() => press(grip, ' '));
			expect(handles(mounted.container)[0]?.getAttribute('aria-pressed')).toBe(
				'true',
			);
			expect(live(mounted.container)).toBe('lifted Alpha 1 of 4');

			await run(() => press(document.activeElement!, 'ArrowDown'));
			await run(() => press(document.activeElement!, 'ArrowDown'));
			expect(labels(mounted.container)).toEqual([
				'Bravo',
				'Charlie',
				'Alpha',
				'Delta',
			]);
			expect(live(mounted.container)).toBe('moved Alpha 3 of 4');
			expect((document.activeElement as HTMLElement).id).toBe('order-handle-a');
			expect(onReorder).not.toHaveBeenCalled();

			await run(() => press(document.activeElement!, ' '));
			expect(onReorder).toHaveBeenCalledTimes(1);
			expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'a', 'd']);
			expect(live(mounted.container)).toBe('dropped Alpha 3 of 4');
			expect(
				handles(mounted.container).every(
					(handle) => handle.getAttribute('aria-pressed') === 'false',
				),
			).toBe(true);
			mounted.unmount();
		},
	);

	it(
		'restores the order on Escape and never reports an unchanged drop',
		async () => {
			const onReorder = vi.fn();
			const mounted = await mount(list(onReorder));
			const grip = handles(mounted.container)[3]!;
			grip.focus();

			await run(() => press(grip, 'Enter'));
			await run(() => press(document.activeElement!, 'ArrowUp'));
			expect(labels(mounted.container)).toEqual([
				'Alpha',
				'Bravo',
				'Delta',
				'Charlie',
			]);
			await run(() => press(document.activeElement!, 'Escape'));
			expect(labels(mounted.container)).toEqual([
				'Alpha',
				'Bravo',
				'Charlie',
				'Delta',
			]);
			expect(live(mounted.container)).toBe('cancelled Delta 4 of 4');

			const first = handles(mounted.container)[0]!;
			first.focus();
			await run(() => press(first, ' '));
			await run(() => press(document.activeElement!, 'ArrowUp'));
			await run(() => press(document.activeElement!, ' '));
			expect(onReorder).not.toHaveBeenCalled();
			mounted.unmount();
		},
	);

	it('puts the item back when focus leaves the lifted grip', async () => {
		const onReorder = vi.fn();
		const mounted = await mount(list(onReorder));
		const grip = handles(mounted.container)[0]!;
		grip.focus();

		await run(() => press(grip, ' '));
		await run(() => press(document.activeElement!, 'ArrowDown'));
		await run(() => handles(mounted.container)[3]!.focus());
		expect(labels(mounted.container)).toEqual([
			'Alpha',
			'Bravo',
			'Charlie',
			'Delta',
		]);
		expect(live(mounted.container)).toBe('cancelled Alpha 1 of 4');
		expect(onReorder).not.toHaveBeenCalled();
		mounted.unmount();
	});

	it(
		'drags with a pointer, marks the drop and reports the order once',
		async () => {
			const onReorder = vi.fn();
			const mounted = await mount(list(onReorder));
			stubRows(mounted.container);
			const grip = handles(mounted.container)[0]!;

			await run(() => pointer(grip, 'pointerdown', 20));
			expect(
				withClass(mounted.container, 'ui-sortable__item--dragging'),
			).toEqual(['Alpha']);
			await run(() => pointer(grip, 'pointermove', 110));
			expect(
				withClass(mounted.container, 'ui-sortable__item--drop-before'),
			).toEqual(['Delta']);
			expect(live(mounted.container)).toBe('moved Alpha 3 of 4');

			await run(() => pointer(grip, 'pointermove', 170));
			expect(
				withClass(mounted.container, 'ui-sortable__item--drop-after'),
			).toEqual(['Delta']);
			await run(() => pointer(grip, 'pointermove', 110));

			await run(() => pointer(grip, 'pointerup', 110));
			expect(onReorder).toHaveBeenCalledTimes(1);
			expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'a', 'd']);
			expect(
				mounted.container.querySelectorAll(
					'.ui-sortable__item--drop-before, .ui-sortable__item--drop-after, .ui-sortable__item--dragging',
				),
			).toHaveLength(0);
			mounted.unmount();
		},
	);

	it(
		'reorders nothing when the pointer is cancelled or another pointer lets go',
		async () => {
			const onReorder = vi.fn();
			const mounted = await mount(list(onReorder));
			stubRows(mounted.container);
			const grip = handles(mounted.container)[1]!;

			await run(() => pointer(grip, 'pointerdown', 60));
			await run(() => pointer(grip, 'pointermove', 170));
			await run(() => pointer(grip, 'pointerup', 170, 2));
			expect(onReorder).not.toHaveBeenCalled();
			await run(() => pointer(grip, 'pointercancel', 170));
			expect(onReorder).not.toHaveBeenCalled();
			expect(live(mounted.container)).toBe('cancelled Bravo 2 of 4');
			expect(
				mounted.container.querySelectorAll('.ui-sortable__item--drop-after'),
			).toHaveLength(0);

			const onEscape = vi.fn();
			window.addEventListener('keydown', onEscape);
			await run(() => pointer(grip, 'pointerdown', 60));
			await run(() => pointer(grip, 'pointermove', 170));
			await run(() => press(document.body, 'Escape'));
			expect(live(mounted.container)).toBe('cancelled Bravo 2 of 4');
			expect(onEscape).not.toHaveBeenCalled();
			await run(() => pointer(grip, 'pointerup', 170));
			expect(onReorder).not.toHaveBeenCalled();
			window.removeEventListener('keydown', onEscape);
			mounted.unmount();
		},
	);

	it('leaves every grip inert while disabled', async () => {
		const onReorder = vi.fn();
		const mounted = await mount(list(onReorder, true));
		expect(handles(mounted.container).every((grip) => grip.disabled)).toBe(
			true,
		);
		mounted.unmount();
	});
});
