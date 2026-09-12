import { describe, expect, it, vi } from 'vitest';
import { DatePicker } from '../src/components/DatePicker.tsrx';
import type { DatePickerPreset } from '../src/components/DatePicker.tsrx';
import { datePresetRange } from '../src/components/calendar.ts';
import type { DateRange } from '../src/components/DateRangeField.tsrx';
import { mount, run } from './dom.ts';

const PRESETS: readonly DatePickerPreset[] = [
	{
		id: 'last-7-days',
		label: 'Last 7 days',
		range: datePresetRange('last-7-days', '2026-09-14'),
	},
	{
		id: 'this-month',
		label: 'This month',
		range: datePresetRange('this-month', '2026-09-14'),
	},
];

function picker(
	value: DateRange,
	onChange: (next: DateRange) => void,
	extra: {
		readonly mode?: 'single' | 'range';
		readonly kind?: 'date' | 'datetime';
		readonly min?: string;
		readonly max?: string;
		readonly presets?: readonly DatePickerPreset[];
	} = {},
) {
	return <DatePicker
		id="window"
		label="Window"
		mode={extra.mode ?? 'single'}
		kind={extra.kind ?? 'date'}
		locale="en-GB"
		value={value}
		min={extra.min}
		max={extra.max}
		presets={extra.presets}
		presetsLabel="Windows"
		fromLabel="From"
		toLabel="To"
		openLabel="Open the calendar"
		previousMonthLabel="Previous month"
		nextMonthLabel="Next month"
		onChange={onChange}
	/>;
}

function trigger(container: HTMLElement): HTMLButtonElement {
	return container.querySelector(
		'.ui-datepicker__trigger',
	) as HTMLButtonElement;
}

function day(container: HTMLElement, iso: string): HTMLButtonElement {
	return container.querySelector(`[data-day="${iso}"]`) as HTMLButtonElement;
}

function focusedDay(): string {
	return (document.activeElement as HTMLElement | null)?.dataset?.day ?? '';
}

/** The one day in the grid's tab order, which focus has to sit on. */
function cursorDay(container: HTMLElement): string {
	return container.querySelector<HTMLElement>(
		'.ui-datepicker__day[tabindex="0"]',
	)?.dataset.day ??
		'';
}

function press(key: string, shiftKey = false): void {
	(document.activeElement ?? document.body).dispatchEvent(
		new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }),
	);
}

async function open(container: HTMLElement) {
	await run(() => trigger(container).click());
}

describe('DatePicker', () => {
	it('carries the ISO value and opens on the month it names', async () => {
		const mounted = await mount(
			picker({ from: '2026-09-14', to: '2026-09-14' }, () => {}),
		);
		const input = mounted.container.querySelector(
			'#window',
		) as HTMLInputElement;
		expect(input.type).toBe('date');
		expect(input.value).toBe('2026-09-14');
		expect(trigger(mounted.container).getAttribute('aria-expanded')).toBe(
			'false',
		);

		await open(mounted.container);
		expect(trigger(mounted.container).getAttribute('aria-expanded')).toBe(
			'true',
		);
		expect(
			mounted.container.querySelector('.ui-datepicker__month')?.textContent,
		).toBe('September 2026');
		expect(day(mounted.container, '2026-09-14').className).toContain(
			'ui-datepicker__day--on',
		);
		expect(focusedDay()).toBe('2026-09-14');
		mounted.unmount();
	});

	it('reports the day the reader picks and closes on the trigger', async () => {
		const onChange = vi.fn();
		const mounted = await mount(
			picker({ from: '2026-09-14', to: '2026-09-14' }, onChange),
		);
		await open(mounted.container);
		await run(() => day(mounted.container, '2026-09-21').click());
		expect(onChange).toHaveBeenCalledWith({
			from: '2026-09-21',
			to: '2026-09-21',
		});
		expect(
			mounted.container.querySelector('.ui-datepicker__popover'),
		).toBeNull();
		expect(document.activeElement).toBe(trigger(mounted.container));
		mounted.unmount();
	});

	it('moves the focused day with the keyboard', async () => {
		const mounted = await mount(
			picker({ from: '2026-09-14', to: '2026-09-14' }, () => {}),
		);
		await open(mounted.container);

		await run(() => press('ArrowRight'));
		expect(focusedDay()).toBe('2026-09-15');
		await run(() => press('ArrowDown'));
		expect(focusedDay()).toBe('2026-09-22');
		await run(() => press('ArrowUp'));
		expect(focusedDay()).toBe('2026-09-15');
		await run(() => press('ArrowLeft'));
		expect(focusedDay()).toBe('2026-09-14');
		await run(() => press('Home'));
		expect(focusedDay()).toBe('2026-09-14');
		await run(() => press('End'));
		expect(focusedDay()).toBe('2026-09-20');
		mounted.unmount();
	});

	/* A day outside the bounds is rendered but never focusable, so a cursor that
   walked onto one would take the tab stop with it and leave the reader's focus
   behind on the day they came from. */
	it('holds the cursor and the focus together at a bound', async () => {
		const mounted = await mount(
			picker({ from: '2026-09-14', to: '2026-09-14' }, () => {}, {
				min: '2026-09-14',
			}),
		);
		await open(mounted.container);

		await run(() => press('ArrowUp'));
		expect(focusedDay()).toBe('2026-09-14');
		expect(cursorDay(mounted.container)).toBe('2026-09-14');

		/* The next keystroke moves from the day under the reader, not from a
	   cursor that walked off on its own. */
		await run(() => press('ArrowRight'));
		expect(focusedDay()).toBe('2026-09-15');
		expect(cursorDay(mounted.container)).toBe('2026-09-15');
		mounted.unmount();
	});

	it('carries the month with a cursor that leaves it', async () => {
		const mounted = await mount(
			picker({ from: '2026-09-14', to: '2026-09-14' }, () => {}),
		);
		await open(mounted.container);
		await run(() => press('PageDown'));
		expect(focusedDay()).toBe('2026-10-14');
		expect(
			mounted.container.querySelector('.ui-datepicker__month')?.textContent,
		).toBe('October 2026');
		await run(() => press('PageUp'));
		expect(
			mounted.container.querySelector('.ui-datepicker__month')?.textContent,
		).toBe('September 2026');
		mounted.unmount();
	});

	it('walks months with the header buttons', async () => {
		const mounted = await mount(
			picker({ from: '2026-09-14', to: '2026-09-14' }, () => {}),
		);
		await open(mounted.container);
		const steps = [
			...mounted.container.querySelectorAll<HTMLButtonElement>(
				'.ui-datepicker__step',
			),
		];
		await run(() => steps[0]?.click());
		expect(
			mounted.container.querySelector('.ui-datepicker__month')?.textContent,
		).toBe('August 2026');
		await run(() => steps[1]?.click());
		await run(() => steps[1]?.click());
		expect(
			mounted.container.querySelector('.ui-datepicker__month')?.textContent,
		).toBe('October 2026');
		mounted.unmount();
	});

	it('never offers a day outside the bounds', async () => {
		const mounted = await mount(
			picker({ from: '2026-09-14', to: '2026-09-14' }, () => {}, {
				min: '2026-09-10',
				max: '2026-09-20',
			}),
		);
		await open(mounted.container);
		expect(day(mounted.container, '2026-09-09').disabled).toBe(true);
		expect(day(mounted.container, '2026-09-10').disabled).toBe(false);
		expect(day(mounted.container, '2026-09-20').disabled).toBe(false);
		expect(day(mounted.container, '2026-09-21').disabled).toBe(true);
		mounted.unmount();
	});

	/* An expiry is a moment, and the calendar only answers about days: picking
   one must not quietly move the moment to midnight, or past a bound. */
	it(
		'keeps the time of a datetime and holds it inside the bounds',
		async () => {
			const onChange = vi.fn();
			const mounted = await mount(
				picker({ from: '2026-09-14T17:30', to: '2026-09-14T17:30' }, onChange, {
					kind: 'datetime',
					min: '2026-09-14T09:00',
				}),
			);
			const input = mounted.container.querySelector(
				'#window',
			) as HTMLInputElement;
			expect(input.type).toBe('datetime-local');

			await open(mounted.container);
			await run(() => day(mounted.container, '2026-09-21').click());
			expect(onChange).toHaveBeenLastCalledWith({
				from: '2026-09-21T17:30',
				to: '2026-09-21T17:30',
			});

			await mounted.render(
				picker({ from: '2026-09-15T08:00', to: '2026-09-15T08:00' }, onChange, {
					kind: 'datetime',
					min: '2026-09-14T09:00',
				}),
			);
			await open(mounted.container);
			await run(() => day(mounted.container, '2026-09-14').click());
			expect(onChange).toHaveBeenLastCalledWith({
				from: '2026-09-14T09:00',
				to: '2026-09-14T09:00',
			});
			mounted.unmount();
		},
	);

	it('takes a window from a preset and marks the one in force', async () => {
		const onChange = vi.fn();
		const mounted = await mount(
			picker({ from: '2026-09-01', to: '2026-09-14' }, onChange, {
				mode: 'range',
				presets: PRESETS,
			}),
		);
		await open(mounted.container);
		const presets = [
			...mounted.container.querySelectorAll<HTMLButtonElement>(
				'.ui-datepicker__preset',
			),
		];
		expect(
			presets.map((preset) => preset.getAttribute('aria-pressed')),
		).toEqual(['false', 'true']);
		await run(() => presets[0]?.click());
		expect(onChange).toHaveBeenCalledWith({
			from: '2026-09-08',
			to: '2026-09-14',
		});
		expect(
			mounted.container.querySelector('.ui-datepicker__popover'),
		).toBeNull();
		mounted.unmount();
	});

	it('picks both ends of a range in one calendar, in order', async () => {
		const onChange = vi.fn();
		const mounted = await mount(
			picker({ from: '', to: '' }, onChange, { mode: 'range' }),
		);
		await open(mounted.container);
		const month = (mounted.container.querySelector(
			'.ui-datepicker__month',
		) as HTMLElement).textContent;
		expect(month).not.toBe('');

		const anchor = mounted.container.querySelector<HTMLButtonElement>(
			'[data-day$="-20"]',
		);
		const anchorDay = anchor?.dataset.day ?? '';
		await run(() => anchor?.click());
		expect(onChange).not.toHaveBeenCalled();
		expect(
			mounted.container.querySelector('.ui-datepicker__popover'),
		).not.toBeNull();

		/* The second end lands before the first, and the range still comes out
	   the right way round. */
		const earlier = anchorDay.slice(0, 8) + '13';
		await run(() => day(mounted.container, earlier).click());
		expect(onChange).toHaveBeenCalledWith({ from: earlier, to: anchorDay });
		mounted.unmount();
	});

	it('renders both ends of a range and labels each input', async () => {
		const mounted = await mount(
			picker({ from: '2026-09-01', to: '2026-09-14' }, () => {}, {
				mode: 'range',
			}),
		);
		const from = mounted.container.querySelector(
			'#window-from',
		) as HTMLInputElement;
		const to = mounted.container.querySelector(
			'#window-to',
		) as HTMLInputElement;
		expect(from.value).toBe('2026-09-01');
		expect(to.value).toBe('2026-09-14');
		expect(from.getAttribute('aria-label')).toBe('From');
		expect(to.getAttribute('aria-label')).toBe('To');
		/* Each side bounds the other, so the picker cannot make a reversed range. */
		expect(from.getAttribute('max')).toBe('2026-09-14');
		expect(to.getAttribute('min')).toBe('2026-09-01');
		mounted.unmount();
	});

	/* Inside a Drawer, the same keystroke must not close both: the calendar
   takes the first Escape and the drawer behind it never sees it. */
	it('closes on Escape without reaching the surface behind it', async () => {
		const behind = vi.fn();
		window.addEventListener('keydown', behind);
		const mounted = await mount(
			picker({ from: '2026-09-14', to: '2026-09-14' }, () => {}),
		);
		await open(mounted.container);
		behind.mockClear();

		await run(() => press('Escape'));
		expect(
			mounted.container.querySelector('.ui-datepicker__popover'),
		).toBeNull();
		expect(document.activeElement).toBe(trigger(mounted.container));
		expect(behind).not.toHaveBeenCalled();
		window.removeEventListener('keydown', behind);
		mounted.unmount();
	});

	/* Tab must not walk the workspace behind an open calendar: the day under the
   reader is the last stop inside it, so the next Tab comes back to the first. */
	it('holds Tab inside the popover', async () => {
		const mounted = await mount(
			picker({ from: '2026-09-14', to: '2026-09-14' }, () => {}, {
				presets: PRESETS,
			}),
		);
		await open(mounted.container);
		expect(focusedDay()).toBe('2026-09-14');

		await run(() => press('Tab'));
		expect(document.activeElement).toBe(
			mounted.container.querySelector('.ui-datepicker__preset'),
		);

		await run(() => press('Tab', true));
		expect(focusedDay()).toBe('2026-09-14');
		mounted.unmount();
	});

	it('closes on the scrim and reports nothing', async () => {
		const onChange = vi.fn();
		const mounted = await mount(
			picker({ from: '2026-09-14', to: '2026-09-14' }, onChange),
		);
		await open(mounted.container);
		await run(() => {
			mounted.container.querySelector<HTMLElement>(
				'.ui-datepicker__scrim',
			)?.click();
		});
		expect(
			mounted.container.querySelector('.ui-datepicker__popover'),
		).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
		/* Dismissing the calendar leaves the reader on the control they opened it
	   from, not at the top of the document. */
		expect(document.activeElement).toBe(trigger(mounted.container));
		mounted.unmount();
	});

	/* The popover is placed against the viewport, so it has no position until it
   has been measured: showing it first paints it in the top-left corner. */
	it('keeps the popover hidden until it is measured', async () => {
		const mounted = await mount(
			picker({ from: '2026-09-14', to: '2026-09-14' }, () => {}),
		);
		trigger(mounted.container).click();
		expect(
			mounted.container.querySelector('.ui-datepicker__popover')?.getAttribute(
				'style',
			),
		).toContain('visibility: hidden');

		await run(() => {});
		const placed =
			mounted.container.querySelector('.ui-datepicker__popover')?.getAttribute(
				'style',
			) ??
				'';
		expect(placed).not.toContain('visibility: hidden');
		expect(placed).toContain('top:');
		mounted.unmount();
	});

	/* Scrolling fires per frame. The reader's own value is read on every render,
   so an unchanged count is the proof that nothing re-rendered. */
	it('re-renders no further when a scroll leaves the placement', async () => {
		let reads = 0;
		const value = {
			get from() {
				reads += 1;
				return '2026-09-14';
			},
			to: '2026-09-14',
		};
		const mounted = await mount(picker(value, () => {}));
		await open(mounted.container);
		const settled = reads;

		await run(() => window.dispatchEvent(new Event('scroll')));
		expect(reads).toBe(settled);
		mounted.unmount();
	});

	it('reports what the reader types into the input', async () => {
		const onChange = vi.fn();
		const mounted = await mount(
			picker({ from: '2026-09-14', to: '2026-09-14' }, onChange),
		);
		const input = mounted.container.querySelector(
			'#window',
		) as HTMLInputElement;
		await run(() => {
			input.value = '2026-10-02';
			input.dispatchEvent(new Event('input', { bubbles: true }));
		});
		expect(onChange).toHaveBeenCalledWith({
			from: '2026-10-02',
			to: '2026-10-02',
		});
		mounted.unmount();
	});
});
