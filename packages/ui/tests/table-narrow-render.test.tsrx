import { describe, expect, it, vi } from 'vitest';
import { CellCode, CellText } from '../src/components/cells.tsrx';
import {
	Table,
	type TableAction,
	type TableColumn,
} from '../src/components/Table.tsrx';
import {
	DEFAULT_TABLE_LOCALE,
	TableLocaleContext,
} from '../src/components/table-locale.ts';
import { mount, run, text } from './dom.ts';

interface Event {
	readonly id: string;
	readonly actor: string;
	readonly action: string;
	readonly subject: string;
	readonly details: string;
}

const EVENTS: readonly Event[] = [
	{
		id: 'e1',
		actor: 'admin@example.com',
		action: 'auth.sign-in.succeeded',
		subject: 'account',
		details: 'ip: 127.0.0.1',
	},
	{
		id: 'e2',
		actor: 'user@example.com',
		action: 'auth.sign-out',
		subject: 'session',
		details: 'reason: idle',
	},
];

const COLUMNS: readonly TableColumn<Event>[] = [
	{
		key: 'actor',
		header: 'Actor',
		width: 'auto',
		priority: 3,
		cell: (row) => <CellText value={row.actor} />,
	},
	{
		key: 'action',
		header: 'Action',
		width: '200px',
		cell: (row) => <CellText value={row.action} mono />,
	},
	{
		key: 'subject',
		header: 'Subject',
		width: '160px',
		priority: 2,
		cell: (row) => <CellText value={row.subject} />,
	},
	{
		key: 'details',
		header: 'Details',
		width: 'auto',
		priority: 3,
		cell: (row) => <CellText value={row.details} wrap />,
	},
];

const EMPTY = { icon: 'activity', title: 'No events' };

function classesOf(container: HTMLElement, selector: string): string[] {
	return [...container.querySelectorAll(selector)].map(
		(node) => node.getAttribute('class') ?? '',
	);
}

describe('Table column priority', () => {
	it('marks every hideable column on its col, header and cells', async () => {
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={EVENTS}
				rowKey={(row) => row.id}
				empty={EMPTY}
			/>,
		);
		const table = mounted.container.querySelector('table') as HTMLTableElement;
		expect(
			[...table.classList].filter((name) => name.startsWith('ui-table--')),
		).toEqual(['ui-table--p3-760', 'ui-table--p2-600']);
		/* The first column is the row's identity and never hides. */
		expect(classesOf(mounted.container, 'col')).toEqual([
			'',
			'',
			'ui-table__p2',
			'ui-table__p3',
		]);
		expect(classesOf(mounted.container, 'thead th')).toEqual([
			'',
			'',
			'ui-table__p2',
			'ui-table__p3',
		]);
		expect(classesOf(mounted.container, 'tbody tr:first-child td')).toEqual([
			'',
			'',
			'ui-table__p2',
			'ui-table__p3',
		]);
		mounted.unmount();
	});

	it('lists the columns a narrow table hides when a row expands', async () => {
		const onSelect = vi.fn();
		const mounted = await mount(
			<TableLocaleContext.Provider
				value={{
					...DEFAULT_TABLE_LOCALE,
					expand: 'Pokaż szczegóły',
					collapse: 'Ukryj szczegóły',
				}}
			>
				<Table
					columns={COLUMNS}
					rows={EVENTS}
					rowKey={(row) => row.id}
					onSelect={onSelect}
					empty={EMPTY}
				/>
			</TableLocaleContext.Provider>,
		);
		const toggle = () => mounted.container.querySelector(
			'tbody tr:first-child .ui-table__toggle',
		) as HTMLButtonElement;
		expect(toggle().getAttribute('aria-expanded')).toBe('false');
		expect(toggle().getAttribute('aria-label')).toBe('Pokaż szczegóły');
		expect(mounted.container.querySelector('.ui-table__details')).toBeNull();

		await run(() => toggle().click());
		expect(onSelect).not.toHaveBeenCalled();
		expect(toggle().getAttribute('aria-expanded')).toBe('true');
		expect(toggle().getAttribute('aria-label')).toBe('Ukryj szczegóły');
		const details = mounted.container.querySelector(
			'.ui-table__details',
		) as HTMLElement;
		expect(toggle().getAttribute('aria-controls')).toBe(details.id);
		/* Only actor and action never hide; a span over a hidden column would add a column. */
		expect(details.querySelector('td')?.getAttribute('colspan')).toBe('2');
		const entries = [...details.querySelectorAll('.ui-table__detail')].map(
			(entry) => ({
				priority: entry.classList.contains('ui-table__detail--p3') ? 3 : 2,
				label: text(entry.querySelector('dt')),
				value: text(entry.querySelector('dd')),
				title: entry.querySelector('dd .ui-cell-text')?.getAttribute('title'),
			}),
		);
		expect(entries).toEqual([
			{ priority: 2, label: 'Subject', value: 'account', title: 'account' },
			{
				priority: 3,
				label: 'Details',
				value: 'ip: 127.0.0.1',
				title: 'ip: 127.0.0.1',
			},
		]);

		await run(() => toggle().click());
		expect(mounted.container.querySelector('.ui-table__details')).toBeNull();
		mounted.unmount();
	});

	it('adds no expand button to a table whose columns never hide', async () => {
		const mounted = await mount(
			<Table
				columns={COLUMNS.map((column) => ({ ...column, priority: 1 as const }))}
				rows={EVENTS}
				rowKey={(row) => row.id}
				empty={EMPTY}
			/>,
		);
		expect(mounted.container.querySelector('.ui-table__toggle')).toBeNull();
		expect(mounted.container.querySelector('.ui-table__lead')).toBeNull();
		expect(mounted.container.querySelector('table')?.className).toBe(
			'ui-table',
		);
		mounted.unmount();
	});
});

describe('Table clickable rows', () => {
	it('opens a row from a real button in its first cell', async () => {
		const onSelect = vi.fn();
		const mounted = await mount(
			<Table
				columns={[
					{
						key: 'id',
						header: 'Id',
						width: 'auto',
						cell: (row: Event) =>
							<CellCode value={row.id + '-4783b5b2-1c5e-4bd8'} />,
					},
					COLUMNS[1] as TableColumn<Event>,
				]}
				rows={EVENTS}
				rowKey={(row) => row.id}
				onSelect={onSelect}
				empty={EMPTY}
			/>,
		);
		const open = mounted.container.querySelector(
			'tbody tr:first-child button.ui-table__open',
		) as HTMLButtonElement;
		expect(open.getAttribute('type')).toBe('button');
		/* A control inside the open button would be invalid markup. */
		expect(open.querySelector('button')).toBeNull();
		await run(() => open.click());
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith(EVENTS[0]);
		mounted.unmount();
	});
});

function actionsOf(
	count: number,
	calls: string[],
): (row: Event) => readonly TableAction[] {
	return (row) => Array.from(
		{ length: count },
		(_unused, index) => ({
			id: 'a' + index,
			label: 'Action ' + index,
			disabled: index === count - 1 && count > 2,
			reason: 'Not now',
			onSelect: () => calls.push(row.id + ':a' + index),
		}),
	);
}

describe('Table row actions', () => {
	it(
		'keeps two actions as buttons that fold below the fold width',
		async () => {
			const mounted = await mount(
				<Table
					columns={COLUMNS}
					rows={EVENTS}
					rowKey={(row) => row.id}
					actions={actionsOf(2, [])}
					actionsLabel="Actions"
					actionsWidth="280px"
					empty={EMPTY}
				/>,
			);
			const table = mounted.container.querySelector(
				'table',
			) as HTMLTableElement;
			expect(table.classList.contains('ui-table--fold-840')).toBe(true);
			expect(table.getAttribute('style')).toContain(
				'--ui-table-actions-width: 280px',
			);
			const cell = mounted.container.querySelector(
				'tbody tr:first-child td.ui-table__actions',
			) as HTMLElement;
			expect(
				cell.querySelectorAll('.ui-table-action-buttons button'),
			).toHaveLength(2);
			const more = cell.querySelector('.ui-table-more') as HTMLElement;
			expect(more.classList.contains('ui-table-more--always')).toBe(false);
			mounted.unmount();
		},
	);

	it(
		'folds more than two actions into a menu that runs one and closes',
		async () => {
			const calls: string[] = [];
			const onSelect = vi.fn();
			const mounted = await mount(
				<Table
					columns={COLUMNS}
					rows={EVENTS}
					rowKey={(row) => row.id}
					actions={actionsOf(3, calls)}
					actionsLabel="Actions"
					actionsWidth="320px"
					onSelect={onSelect}
					empty={EMPTY}
				/>,
			);
			const table = mounted.container.querySelector(
				'table',
			) as HTMLTableElement;
			expect(table.getAttribute('style')).toContain(
				'--ui-table-actions-width: 64px',
			);
			expect(
				[...table.classList].some((name) => name.startsWith('ui-table--fold-')),
			).toBe(false);
			const cell = mounted.container.querySelector(
				'tbody tr:first-child td.ui-table__actions',
			) as HTMLElement;
			expect(cell.querySelector('.ui-table-action-buttons')).toBeNull();
			const trigger = cell.querySelector('.ui-table-more') as HTMLButtonElement;
			expect(trigger.classList.contains('ui-table-more--always')).toBe(true);
			expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
			expect(trigger.getAttribute('aria-expanded')).toBe('false');

			await run(() => trigger.click());
			const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
			expect(menu).not.toBeNull();
			expect(mounted.container.contains(menu)).toBe(false);
			expect(trigger.getAttribute('aria-expanded')).toBe('true');
			expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
			const items = [
				...menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
			];
			expect(items.map((item) => text(item))).toEqual([
				'Action 0',
				'Action 1',
				'Action 2',
			]);
			expect(document.activeElement).toBe(items[0]);
			await run(() => {
				menu.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
				);
			});
			expect(document.activeElement).toBe(items[1]);
			await run(() => {
				items[1]?.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
				);
			});
			expect(document.activeElement).toBe(items[2]);

			/* A refused action stays in the list with its reason and runs nothing. */
			const refused = items[2] as HTMLElement;
			expect(refused.getAttribute('aria-disabled')).toBe('true');
			expect(
				text(
					document.getElementById(
						refused.getAttribute('aria-describedby') ?? '',
					),
				),
			).toBe('Not now');
			await run(() => refused.click());
			expect(calls).toEqual([]);

			await run(() => (items[1] as HTMLElement).click());
			expect(calls).toEqual(['e1:a1']);
			expect(onSelect).not.toHaveBeenCalled();
			expect(document.body.querySelector('[role="menu"]')).toBeNull();
			expect(document.activeElement).toBe(trigger);
			mounted.unmount();
		},
	);

	it('closes on Escape without reaching a dialog behind it', async () => {
		const onWindowKey = vi.fn();
		window.addEventListener('keydown', onWindowKey);
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={EVENTS}
				rowKey={(row) => row.id}
				actions={actionsOf(3, [])}
				actionsLabel="Actions"
				empty={EMPTY}
			/>,
		);
		const trigger = mounted.container.querySelector(
			'.ui-table-more',
		) as HTMLButtonElement;
		await run(() => {
			trigger.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'ArrowUp',
					bubbles: true,
					cancelable: true,
				}),
			);
		});
		const items = [
			...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
		];
		expect(document.activeElement).toBe(items[2]);
		await run(() => {
			items[2]?.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				}),
			);
		});
		expect(document.body.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		expect(onWindowKey).not.toHaveBeenCalledWith(
			expect.objectContaining({ key: 'Escape' }),
		);
		window.removeEventListener('keydown', onWindowKey);
		mounted.unmount();
	});
});
