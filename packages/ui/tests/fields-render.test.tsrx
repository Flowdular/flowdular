import { describe, expect, it, vi } from 'vitest';
import { DateField } from '../src/components/DateField.tsrx';
import { DateRangeField } from '../src/components/DateRangeField.tsrx';
import { Select } from '../src/components/Select.tsrx';
import { mount, run, text } from './dom.ts';

const OPTIONS = [
	{ value: 'owner', label: 'Owner' },
	{ value: 'member', label: 'Member' },
	{ value: 'auditor', label: 'Auditor', disabled: true },
];

function describedIds(input: Element | null): readonly string[] {
	return (input?.getAttribute('aria-describedby') ?? '').split(' ').filter(
		Boolean,
	);
}

describe('Select', () => {
	it(
		'labels the control, offers the placeholder and reports a choice',
		async () => {
			const onChange = vi.fn();
			const mounted = await mount(
				<Select
					id="role"
					label="Role"
					options={OPTIONS}
					value=""
					placeholder="Pick a role"
					help="Owners manage the workspace."
					onChange={onChange}
				/>,
			);
			const select = mounted.container.querySelector(
				'select.ui-select',
			) as HTMLSelectElement;
			expect(
				mounted.container.querySelector('label.ui-label')?.getAttribute('for'),
			).toBe('role');
			expect(select.id).toBe('role');
			expect(select.name).toBe('role');
			expect(Array.from(select.options).map((option) => option.value)).toEqual([
				'',
				'owner',
				'member',
				'auditor',
			]);
			expect(select.options[3]?.disabled).toBe(true);
			expect(describedIds(select)).toEqual(['role-help']);
			await run(() => {
				select.value = 'member';
				select.dispatchEvent(new Event('input', { bubbles: true }));
			});
			expect(onChange).toHaveBeenCalledWith('member');
			mounted.unmount();
		},
	);

	it(
		'replaces the help line with the error and marks the control',
		async () => {
			const mounted = await mount(
				<Select
					id="role"
					label="Role"
					options={OPTIONS}
					value=""
					help="Owners manage the workspace."
					error="Pick a role first."
					onChange={() => {}}
				/>,
			);
			const select = mounted.container.querySelector(
				'select.ui-select',
			) as HTMLSelectElement;
			expect(select.classList.contains('ui-select--error')).toBe(true);
			expect(select.getAttribute('aria-invalid')).toBe('true');
			expect(describedIds(select)).toEqual(['role-error']);
			expect(text(mounted.container.querySelector('#role-error'))).toBe(
				'Pick a role first.',
			);
			mounted.unmount();
		},
	);

	it('takes focus on mount only when the screen asked for it', async () => {
		const plain = await mount(
			<Select
				id="role"
				label="Role"
				options={OPTIONS}
				value=""
				onChange={() => {}}
			/>,
		);
		expect(document.activeElement?.id).not.toBe('role');
		plain.unmount();

		const focused = await mount(
			<Select
				id="role"
				label="Role"
				options={OPTIONS}
				value=""
				autoFocus
				onChange={() => {}}
			/>,
		);
		expect(document.activeElement?.id).toBe('role');
		focused.unmount();
	});
});

describe('DateField', () => {
	it(
		'keeps the ISO value in the control and repeats it in the reading',
		async () => {
			const onChange = vi.fn();
			const mounted = await mount(
				<DateField
					id="runs-at"
					label="Runs at"
					kind="datetime"
					locale="en-GB"
					value="2026-09-11T14:30"
					help="Stored as ISO."
					onChange={onChange}
				/>,
			);
			const input = mounted.container.querySelector(
				'input.ui-input',
			) as HTMLInputElement;
			expect(input.type).toBe('datetime-local');
			expect(input.value).toBe('2026-09-11T14:30');
			/* The exact month word belongs to the reader's ICU data; what the reading
   owes the reader is the same day and time as the control. */
			expect(
				text(mounted.container.querySelector('.ui-datefield__reading')),
			).toMatch(/11.*2026.*14:30/);
			expect(describedIds(input)).toEqual(['runs-at-help']);
			await run(() => {
				input.value = '2026-09-12T08:00';
				input.dispatchEvent(new Event('input', { bubbles: true }));
			});
			expect(onChange).toHaveBeenCalledWith('2026-09-12T08:00');
			mounted.unmount();
		},
	);
});

describe('DateRangeField', () => {
	it(
		'bounds each side by the other and describes both from the group',
		async () => {
			const mounted = await mount(
				<DateRangeField
					id="period"
					legend="Reporting period"
					fromLabel="From"
					toLabel="To"
					value={{ from: '2026-09-20', to: '2026-09-22' }}
					min="2026-01-01"
					max="2026-12-31"
					help="Both days are included."
					reversedMessage="The end is before the start."
					onChange={() => {}}
				/>,
			);
			const [from, to] = Array.from(
				mounted.container.querySelectorAll('input.ui-input'),
			) as HTMLInputElement[];
			expect(from?.id).toBe('period-from');
			expect(to?.id).toBe('period-to');
			expect(from?.max).toBe('2026-09-22');
			expect(to?.min).toBe('2026-09-20');
			expect(text(mounted.container.querySelector('#period-help'))).toBe(
				'Both days are included.',
			);
			expect(describedIds(from ?? null)).toContain('period-help');
			expect(describedIds(to ?? null)).toContain('period-help');
			mounted.unmount();
		},
	);

	it('reports a reversed range from both sides', async () => {
		const mounted = await mount(
			<DateRangeField
				id="period"
				legend="Reporting period"
				fromLabel="From"
				toLabel="To"
				value={{ from: '2026-09-22', to: '2026-09-20' }}
				help="Both days are included."
				reversedMessage="The end is before the start."
				onChange={() => {}}
			/>,
		);
		const inputs = Array.from(
			mounted.container.querySelectorAll('input.ui-input'),
		) as HTMLInputElement[];
		const message = mounted.container.querySelector('#period-error');
		expect(text(message)).toBe('The end is before the start.');
		expect(message?.getAttribute('role')).toBe('alert');
		for (const input of inputs) {
			expect(input.getAttribute('aria-invalid')).toBe('true');
			expect(describedIds(input)).toContain('period-error');
		}
		mounted.unmount();
	});
});
