import { useState } from 'octane';
import { describe, expect, it, vi } from 'vitest';
import {
	Table,
	tableMinWidth,
	type TableBulkAction,
	type TableColumn,
} from '../src/components/Table.tsrx';
import { mount, run, text } from './dom.ts';

interface Person {
	readonly id: string;
	readonly name: string;
	readonly seats: number;
}

const COLUMNS: readonly TableColumn<Person>[] = [
	{
		key: 'name',
		header: 'Name',
		width: '50%',
		value: (row) => row.name,
		cell: (row) => row.name,
	},
	{
		key: 'seats',
		header: 'Seats',
		width: '25%',
		numeric: true,
		value: (row) => row.seats,
		cell: (row) => String(row.seats),
	},
	{
		key: 'badge',
		header: 'Badge',
		width: '25%',
		cell: (row) => row.id,
	},
];

const EMPTY = { icon: 'users', title: 'No people yet' };
const EMPTY_FILTERED = { icon: 'users', title: 'No match' };

function members(count: number): readonly Person[] {
	return Array.from(
		{ length: count },
		(_unused, index) => ({
			id: 'member-' + index,
			name: 'Member ' + index,
			seats: index,
		}),
	);
}

const AUDITORS: readonly Person[] = [
	{ id: 'auditor-1', name: 'Auditor one', seats: 101 },
	{ id: 'auditor-2', name: 'Auditor two', seats: 102 },
	{ id: 'auditor-3', name: 'Auditor three', seats: 103 },
];

function rowTexts(container: HTMLElement): readonly string[] {
	return Array.from(container.querySelectorAll('tbody tr')).map(
		(row) => text(row),
	);
}

function headerCells(container: HTMLElement): readonly HTMLElement[] {
	return Array.from(container.querySelectorAll('thead th'));
}

describe('Table sorting', () => {
	it(
		'marks every sortable header and leaves a presentation column alone',
		async () => {
			const mounted = await mount(
				<Table
					columns={COLUMNS}
					rows={members(3)}
					rowKey={(row) => row.id}
					sorting
					empty={EMPTY}
					caption="People"
				/>,
			);
			const headers = headerCells(mounted.container);
			expect(
				headers.map((header) => header.getAttribute('aria-sort')),
			).toEqual([
				'none',
				'none',
				null,
			]);
			expect(
				headers.map(
					(header) => header.querySelector('.ui-table__sort') !== null,
				),
			).toEqual([true, true, false]);
			mounted.unmount();
		},
	);

	it('sorts through the header button and reports the change', async () => {
		const onSortingChange = vi.fn();
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={members(3)}
				rowKey={(row) => row.id}
				sorting
				onSortingChange={onSortingChange}
				empty={EMPTY}
				caption="People"
			/>,
		);
		const button = headerCells(mounted.container)[0]?.querySelector(
			'.ui-table__sort',
		) as HTMLButtonElement;
		await run(() => button.click());
		expect(onSortingChange).toHaveBeenCalledWith([
			{ key: 'name', desc: false },
		]);
		expect(headerCells(mounted.container)[0]?.getAttribute('aria-sort')).toBe(
			'ascending',
		);
		expect(rowTexts(mounted.container)[0]).toContain('Member 0');
		await run(() => button.click());
		expect(headerCells(mounted.container)[0]?.getAttribute('aria-sort')).toBe(
			'descending',
		);
		expect(rowTexts(mounted.container)[0]).toContain('Member 2');
		mounted.unmount();
	});

	it(
		'leaves headers unsorted when the screen did not ask for sorting',
		async () => {
			const mounted = await mount(
				<Table
					columns={COLUMNS}
					rows={members(3)}
					rowKey={(row) => row.id}
					empty={EMPTY}
					caption="People"
				/>,
			);
			const headers = headerCells(mounted.container);
			expect(
				headers.map((header) => header.getAttribute('aria-sort')),
			).toEqual([
				null,
				null,
				null,
			]);
			expect(mounted.container.querySelector('.ui-table__sort')).toBeNull();
			mounted.unmount();
		},
	);
});

describe('Table pagination', () => {
	it('slices the rows the screen asked for', async () => {
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={members(30)}
				rowKey={(row) => row.id}
				pagination={{ pageIndex: 1, pageSize: 10, onPageChange: () => {} }}
				empty={EMPTY}
				caption="People"
			/>,
		);
		const rows = rowTexts(mounted.container);
		expect(rows).toHaveLength(10);
		expect(rows[0]).toContain('Member 10');
		expect(rows[9]).toContain('Member 19');
		mounted.unmount();
	});

	it('reports the clamped page when the row set shrinks under it', async () => {
		const onPageChange = vi.fn();
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={members(30)}
				rowKey={(row) => row.id}
				pagination={{ pageIndex: 2, pageSize: 10, onPageChange }}
				empty={EMPTY}
				caption="People"
			/>,
		);
		expect(onPageChange).not.toHaveBeenCalled();
		await mounted.render(
			<Table
				columns={COLUMNS}
				rows={members(12)}
				rowKey={(row) => row.id}
				pagination={{ pageIndex: 2, pageSize: 10, onPageChange }}
				empty={EMPTY}
				caption="People"
			/>,
		);
		expect(onPageChange).toHaveBeenCalledWith(1);
		expect(rowTexts(mounted.container)).toHaveLength(2);
		mounted.unmount();
	});

	it('renders the page the module already sliced in SQL', async () => {
		const onPageChange = vi.fn();
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={members(10)}
				rowKey={(row) => row.id}
				pagination={{
					pageIndex: 4,
					pageSize: 10,
					totalRows: 120,
					onPageChange,
				}}
				empty={EMPTY}
				caption="People"
			/>,
		);
		expect(rowTexts(mounted.container)).toHaveLength(10);
		expect(onPageChange).not.toHaveBeenCalled();
		mounted.unmount();
	});
});

describe('Table globalFilter with client-side pagination', () => {
	it('pages the filtered rows rather than the whole set', async () => {
		const onPageChange = vi.fn();
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={[...members(30), ...AUDITORS]}
				rowKey={(row) => row.id}
				globalFilter="Auditor"
				pagination={{ pageIndex: 1, pageSize: 25, onPageChange }}
				empty={EMPTY}
				emptyFiltered={EMPTY_FILTERED}
				caption="People"
			/>,
		);
		const rows = rowTexts(mounted.container);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toContain('Auditor one');
		expect(onPageChange).toHaveBeenCalledWith(0);
		mounted.unmount();
	});

	it('narrows the set and keeps the reader on a page that exists', async () => {
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={[...members(30), ...AUDITORS]}
				rowKey={(row) => row.id}
				globalFilter="Auditor"
				pagination={{ pageIndex: 0, pageSize: 2, onPageChange: () => {} }}
				empty={EMPTY}
				emptyFiltered={EMPTY_FILTERED}
				caption="People"
			/>,
		);
		expect(rowTexts(mounted.container)).toHaveLength(2);
		mounted.unmount();
	});

	it('shows the filtered-empty state when nothing matches', async () => {
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={members(30)}
				rowKey={(row) => row.id}
				globalFilter="Auditor"
				pagination={{ pageIndex: 0, pageSize: 25, onPageChange: () => {} }}
				empty={EMPTY}
				emptyFiltered={EMPTY_FILTERED}
				caption="People"
			/>,
		);
		expect(text(mounted.container.querySelector('tbody'))).toContain(
			'No match',
		);
		mounted.unmount();
	});
});

describe('Table server mode', () => {
	it('renders the rows as they arrive and narrows nothing', async () => {
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={[...AUDITORS, ...members(2)]}
				rowKey={(row) => row.id}
				mode="server"
				sorting
				globalFilter="Auditor"
				pagination={{ pageIndex: 0, pageSize: 2, onPageChange: () => {} }}
				empty={EMPTY}
				emptyFiltered={EMPTY_FILTERED}
				caption="People"
			/>,
		);
		const rows = rowTexts(mounted.container);
		expect(rows).toHaveLength(5);
		expect(rows[0]).toContain('Auditor one');
		expect(rows[4]).toContain('Member 1');
		mounted.unmount();
	});

	it('reports a sort instead of reordering the rows', async () => {
		const onSortingChange = vi.fn();
		const descending = [...members(3)].reverse();
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={descending}
				rowKey={(row) => row.id}
				mode="server"
				sorting
				onSortingChange={onSortingChange}
				empty={EMPTY}
				caption="People"
			/>,
		);
		const button = headerCells(mounted.container)[0]?.querySelector(
			'.ui-table__sort',
		) as HTMLButtonElement;
		await run(() => button.click());
		expect(onSortingChange).toHaveBeenCalledWith([
			{ key: 'name', desc: false },
		]);
		expect(headerCells(mounted.container)[0]?.getAttribute('aria-sort')).toBe(
			'ascending',
		);
		expect(rowTexts(mounted.container)[0]).toContain('Member 2');
		mounted.unmount();
	});

	it('clamps against a total the module counted', async () => {
		const onPageChange = vi.fn();
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={members(2)}
				rowKey={(row) => row.id}
				mode="server"
				pagination={{
					pageIndex: 4,
					pageSize: 10,
					totalRows: 12,
					onPageChange,
				}}
				empty={EMPTY}
				caption="People"
			/>,
		);
		expect(onPageChange).toHaveBeenCalledWith(1);
		expect(rowTexts(mounted.container)).toHaveLength(2);
		mounted.unmount();
	});

	it('walks a keyset page back when it ran off the end', async () => {
		const onPageChange = vi.fn();
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={[]}
				rowKey={(row) => row.id}
				mode="server"
				pagination={{ pageIndex: 2, pageSize: 10, onPageChange }}
				empty={EMPTY}
				caption="People"
			/>,
		);
		expect(onPageChange).toHaveBeenCalledWith(1);
		mounted.unmount();
	});

	it('leaves a keyset page alone while there is more behind it', async () => {
		const onPageChange = vi.fn();
		const full = await mount(
			<Table
				columns={COLUMNS}
				rows={members(10)}
				rowKey={(row) => row.id}
				mode="server"
				pagination={{
					pageIndex: 2,
					pageSize: 10,
					hasMore: true,
					onPageChange,
				}}
				empty={EMPTY}
				caption="People"
			/>,
		);
		expect(rowTexts(full.container)).toHaveLength(10);
		expect(onPageChange).not.toHaveBeenCalled();
		full.unmount();

		const waiting = await mount(
			<Table
				columns={COLUMNS}
				rows={[]}
				rowKey={(row) => row.id}
				mode="server"
				status="loading"
				pagination={{
					pageIndex: 2,
					pageSize: 10,
					hasMore: true,
					onPageChange,
				}}
				empty={EMPTY}
				caption="People"
			/>,
		);
		expect(onPageChange).not.toHaveBeenCalled();
		waiting.unmount();
	});

	/* A refresh empties the rows while the request is in flight. That is not the
   reader walking off the end of the set, so the page must stay where it is. */
	it('leaves a keyset page alone while it waits for its rows', async () => {
		const onPageChange = vi.fn();
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={[]}
				rowKey={(row) => row.id}
				mode="server"
				status="loading"
				pagination={{
					pageIndex: 1,
					pageSize: 10,
					hasMore: false,
					onPageChange,
				}}
				empty={EMPTY}
				caption="People"
			/>,
		);
		expect(onPageChange).not.toHaveBeenCalled();

		/* The same page, once it has answered with nothing, does walk back. */
		await mounted.render(
			<Table
				columns={COLUMNS}
				rows={[]}
				rowKey={(row) => row.id}
				mode="server"
				pagination={{
					pageIndex: 1,
					pageSize: 10,
					hasMore: false,
					onPageChange,
				}}
				empty={EMPTY}
				caption="People"
			/>,
		);
		expect(onPageChange).toHaveBeenCalledWith(0);
		mounted.unmount();
	});
});

describe('Table action reasons', () => {
	function actionButton(container: HTMLElement): HTMLButtonElement {
		return container.querySelector(
			'.ui-table-action-buttons button',
		) as HTMLButtonElement;
	}

	it('describes a refused action with its reason', async () => {
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={members(2)}
				rowKey={(row) => row.id}
				actions={() => [
					{
						id: 'download',
						label: 'Download',
						disabled: true,
						reason: 'The object was deleted.',
						onSelect: () => {},
					},
				]}
				actionsLabel="Actions"
				empty={EMPTY}
				caption="People"
			/>,
		);
		const buttons = [
			...mounted.container.querySelectorAll<HTMLButtonElement>(
				'.ui-table-action-buttons button',
			),
		];
		const described = buttons.map(
			(button) => button.getAttribute('aria-describedby') ?? '',
		);
		expect(described.filter(Boolean)).toHaveLength(2);
		/* Two rows, two descriptions: an id repeated across rows would point
	   every reader at the first row's reason. */
		expect(new Set(described).size).toBe(2);
		for (const id of described) expect(text(document.getElementById(id))).toBe(
			'The object was deleted.',
		);
		expect(text(buttons[0] as Element)).toBe('Download');
		expect(
			mounted.container.querySelector('.ui-table-action')?.getAttribute(
				'title',
			),
		).toBe('The object was deleted.');
		mounted.unmount();
	});

	it('leaves an action nobody refused undescribed', async () => {
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={members(1)}
				rowKey={(row) => row.id}
				actions={() => [
					{
						id: 'download',
						label: 'Download',
						reason: 'The object was deleted.',
						onSelect: () => {},
					},
				]}
				actionsLabel="Actions"
				empty={EMPTY}
				caption="People"
			/>,
		);
		expect(
			actionButton(mounted.container).getAttribute('aria-describedby'),
		).toBeNull();
		expect(mounted.container.querySelector('.ui-visually-hidden')).toBeNull();
		expect(
			mounted.container.querySelector('.ui-table-action')?.getAttribute(
				'title',
			),
		).toBeNull();
		mounted.unmount();
	});
});

function Selectable(props: {
	readonly rows: readonly Person[];
	readonly initial?: readonly string[] | undefined;
	readonly mode?: 'client' | 'server' | undefined;
	readonly selectable?: ((row: Person) => boolean) | undefined;
	readonly onSelect?: ((row: Person) => void) | undefined;
	readonly bulk?: readonly TableBulkAction[] | undefined;
	readonly totalRows?: number | undefined;
}) @{
	const [keys, setKeys] = useState<ReadonlySet<string>>(
		new Set(props.initial ?? []),
	);

	<Table
		columns={COLUMNS}
		rows={props.rows}
		rowKey={(row) => row.id}
		mode={props.mode}
		pagination={{
			pageIndex: 0,
			pageSize: 2,
			totalRows: props.totalRows,
			onPageChange: () => {},
		}}
		selection={{
			selectedKeys: keys,
			onSelectionChange: setKeys,
			label: 'Select all people',
			rowLabel: (row) => 'Select ' + row.name,
			selectable: props.selectable,
			clearLabel: 'Clear',
		}}
		bulkActions={props.bulk}
		onSelect={props.onSelect}
		empty={EMPTY}
		caption="People"
	/>
}

describe('Table selection', () => {
	function header(container: HTMLElement): HTMLInputElement {
		return container.querySelector(
			'th.ui-table__select input',
		) as HTMLInputElement;
	}

	function boxes(container: HTMLElement): readonly HTMLInputElement[] {
		return [
			...container.querySelectorAll<HTMLInputElement>(
				'td.ui-table__select input',
			),
		];
	}

	function live(container: HTMLElement): string {
		return text(container.querySelector('[aria-live="polite"]'));
	}

	it('renders no checkbox column without the prop', async () => {
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={members(2)}
				rowKey={(row) => row.id}
				empty={EMPTY}
				caption="People"
			/>,
		);
		expect(mounted.container.querySelector('.ui-table__select')).toBeNull();
		expect(mounted.container.querySelector('[aria-live]')).toBeNull();
		expect(
			mounted.container.querySelector('tbody tr')?.hasAttribute(
				'aria-selected',
			),
		).toBe(false);
		mounted.unmount();
	});

	it('toggles only the page on screen from the header', async () => {
		const mounted = await mount(<Selectable rows={members(5)} />);
		expect(header(mounted.container).getAttribute('aria-checked')).toBe(
			'false',
		);
		await run(() => header(mounted.container).click());
		expect(boxes(mounted.container).map((box) => box.checked)).toEqual([
			true,
			true,
		]);
		expect(live(mounted.container)).toBe('2 selected');
		expect(header(mounted.container).getAttribute('aria-checked')).toBe('true');
		await run(() => header(mounted.container).click());
		expect(boxes(mounted.container).map((box) => box.checked)).toEqual([
			false,
			false,
		]);
		expect(live(mounted.container)).toBe('0 selected');
		mounted.unmount();
	});

	it('toggles the page the module gave in server mode', async () => {
		const onSelect = vi.fn();
		const mounted = await mount(
			<Selectable
				rows={members(3)}
				mode="server"
				totalRows={30}
				bulk={[
					{ id: 'go', label: 'Go', onSelect },
				]}
			/>,
		);
		await run(() => header(mounted.container).click());
		expect(boxes(mounted.container).map((box) => box.checked)).toEqual([
			true,
			true,
			true,
		]);
		await run(() => {
			(mounted.container.querySelector(
				'.ui-table__bulk .ui-table-action-buttons button',
			) as HTMLButtonElement).click();
		});
		expect(onSelect).toHaveBeenCalledWith(['member-0', 'member-1', 'member-2']);
		mounted.unmount();
	});

	it('reads mixed while only some rows on screen are selected', async () => {
		const mounted = await mount(<Selectable rows={members(3)} />);
		await run(() => (boxes(mounted.container)[0] as HTMLInputElement).click());
		const all = header(mounted.container);
		expect(all.getAttribute('aria-checked')).toBe('mixed');
		expect(all.indeterminate).toBe(true);
		expect(all.checked).toBe(false);
		/* Mixed resolves to everything on screen selected, never to nothing. */
		await run(() => all.click());
		expect(boxes(mounted.container).map((box) => box.checked)).toEqual([
			true,
			true,
		]);
		expect(header(mounted.container).indeterminate).toBe(false);
		mounted.unmount();
	});

	it('keeps a row checkbox click away from the row action', async () => {
		const onSelect = vi.fn();
		const mounted = await mount(
			<Selectable rows={members(2)} onSelect={onSelect} />,
		);
		await run(() => (boxes(mounted.container)[1] as HTMLInputElement).click());
		expect(onSelect).not.toHaveBeenCalled();
		expect(boxes(mounted.container)[1]?.checked).toBe(true);
		expect(
			[...mounted.container.querySelectorAll('tbody tr')].map(
				(row) => row.getAttribute('aria-selected'),
			),
		).toEqual(['false', 'true']);
		await run(() => {
			(mounted.container.querySelector(
				'tbody td:nth-child(2)',
			) as HTMLElement).click();
		});
		expect(onSelect).toHaveBeenCalledTimes(1);
		mounted.unmount();
	});

	it('toggles from the keyboard', async () => {
		const mounted = await mount(<Selectable rows={members(2)} />);
		const box = boxes(mounted.container)[0] as HTMLInputElement;
		const space = new KeyboardEvent('keydown', {
			key: ' ',
			bubbles: true,
			cancelable: true,
		});
		await run(() => box.dispatchEvent(space));
		/* Space is the checkbox's own key: nothing intercepts it. */
		expect(space.defaultPrevented).toBe(false);
		await run(() => {
			box.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Enter',
					bubbles: true,
					cancelable: true,
				}),
			);
		});
		expect(boxes(mounted.container)[0]?.checked).toBe(true);
		await run(() => {
			header(mounted.container).dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Enter',
					bubbles: true,
					cancelable: true,
				}),
			);
		});
		expect(boxes(mounted.container).map((box) => box.checked)).toEqual([
			true,
			true,
		]);
		mounted.unmount();
	});

	it(
		'gives an unselectable row no checkbox and skips it in the header',
		async () => {
			const mounted = await mount(
				<Selectable
					rows={members(2)}
					selectable={(row) => row.id !== 'member-0'}
				/>,
			);
			const cells = mounted.container.querySelectorAll('td.ui-table__select');
			expect(cells).toHaveLength(2);
			expect(cells[0]?.querySelector('input')).toBeNull();
			expect(cells[1]?.querySelector('input')?.getAttribute('aria-label')).toBe(
				'Select Member 1',
			);
			await run(() => header(mounted.container).click());
			expect(live(mounted.container)).toBe('1 selected');
			expect(header(mounted.container).getAttribute('aria-checked')).toBe(
				'true',
			);
			mounted.unmount();
		},
	);

	it('shows the bulk bar with a selection and clears it', async () => {
		const archive = vi.fn();
		const mounted = await mount(
			<Selectable
				rows={members(3)}
				initial={['member-0', 'member-2']}
				bulk={[
					{ id: 'archive', label: 'Archive', onSelect: archive },
					{
						id: 'delete',
						label: 'Delete',
						tone: 'danger',
						disabled: true,
						reason: 'Locked records cannot be deleted.',
						onSelect: () => {},
					},
				]}
			/>,
		);
		const bar = mounted.container.querySelector(
			'.ui-table__bulk',
		) as HTMLElement;
		expect(text(bar.querySelector('.ui-table__bulk-count'))).toBe('2 selected');
		expect(live(mounted.container)).toBe('2 selected');
		const buttons = [
			...bar.querySelectorAll<HTMLButtonElement>(
				'.ui-table-action-buttons button',
			),
		];
		expect(buttons.map((button) => text(button))).toEqual([
			'Archive',
			'Delete',
		]);
		expect(buttons[0]?.getAttribute('aria-describedby')).toBeNull();
		const reasonId = buttons[1]?.getAttribute('aria-describedby') ?? '';
		expect(buttons[1]?.disabled).toBe(true);
		expect(text(document.getElementById(reasonId))).toBe(
			'Locked records cannot be deleted.',
		);
		await run(() => buttons[0]?.click());
		expect(archive).toHaveBeenCalledWith(['member-0', 'member-2']);
		const clear = [...bar.querySelectorAll('button')].find(
			(button) => text(button) === 'Clear',
		) as HTMLButtonElement;
		await run(() => clear.click());
		expect(mounted.container.querySelector('.ui-table__bulk')).toBeNull();
		expect(boxes(mounted.container).some((box) => box.checked)).toBe(false);
		expect(live(mounted.container)).toBe('0 selected');
		mounted.unmount();
	});

	it('announces through the summary the screen translated', async () => {
		const mounted = await mount(
			<Table
				columns={COLUMNS}
				rows={members(2)}
				rowKey={(row) => row.id}
				selection={{
					selectedKeys: new Set(['member-1']),
					onSelectionChange: () => {},
					label: 'Select all people',
					rowLabel: (row) => row.name,
				}}
				selectionSummary={(count) => 'Wybrano: ' + count}
				empty={EMPTY}
				caption="People"
			/>,
		);
		expect(live(mounted.container)).toBe('Wybrano: 1');
		expect(text(mounted.container.querySelector('.ui-table__bulk-count'))).toBe(
			'Wybrano: 1',
		);
		mounted.unmount();
	});

	it('leaves the bulk bar out while nothing is selected', async () => {
		const mounted = await mount(
			<Selectable
				rows={members(2)}
				bulk={[
					{ id: 'archive', label: 'Archive', onSelect: () => {} },
				]}
			/>,
		);
		expect(mounted.container.querySelector('.ui-table__bulk')).toBeNull();
		expect(header(mounted.container).getAttribute('aria-label')).toBe(
			'Select all people',
		);
		mounted.unmount();
	});
});

describe('Table minimum width', () => {
	it('keeps px columns whole and leaves room for each flexible column', () => {
		expect(tableMinWidth(['50%', '25%', '25%'])).toBe(640);
		expect(
			tableMinWidth([
				'auto',
				'120px',
				'200px',
				'140px',
				'170px',
				'130px',
				'236px',
			]),
		).toBe(1116);
		expect(tableMinWidth(['44px', '30%', ' 300px ', undefined])).toBe(640);
		expect(tableMinWidth(['400px', '400px', '10%'])).toBe(920);
	});

	it(
		'sets the minimum on the table and titles each header with its label',
		async () => {
			const mounted = await mount(
				<Table
					columns={COLUMNS}
					rows={AUDITORS}
					rowKey={(row) => row.id}
					actions={() => []}
					actionsLabel="Actions"
					actionsWidth="480px"
					empty={EMPTY}
					caption="People"
				/>,
			);
			const table = mounted.container.querySelector(
				'table',
			) as HTMLTableElement;
			expect(table.getAttribute('style')).toContain('min-width: 840px');
			expect(headerCells(mounted.container)[0]?.getAttribute('title')).toBe(
				'Name',
			);
			mounted.unmount();
		},
	);
});
