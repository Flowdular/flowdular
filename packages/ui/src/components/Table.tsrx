import { useEffect, useMemo, useState } from 'octane';
import type { OctaneNode } from 'octane';
import {
	columnFilteringFeature,
	createCoreRowModel,
	createFilteredRowModel,
	createSortedRowModel,
	flexRender,
	globalFilteringFeature,
	rowPaginationFeature,
	rowSortingFeature,
	tableFeatures,
	useTable,
	type ColumnDef,
	type RowData,
} from '@octanejs/tanstack-table';
import { Icon } from '../icons/Icon.tsrx';
import { Button } from './Button.tsrx';
import { EmptyState } from './EmptyState.tsrx';
import { pageRange } from './pagination.ts';
import {
	compareCellValues,
	sortingSignature,
	type TableSort,
	type TableSortChange,
} from './table-sorting.ts';

export type TableStatus = 'idle' | 'loading';

export interface TableColumn<Row extends RowData> {
	readonly key: string;
	readonly header: string;
	/** Tabular figures, right aligned: the th and td carry `num`. */
	readonly numeric?: boolean | undefined;
	/** Required CSS width, e.g. '120px' or '20%', to prevent layout drift. */
	readonly width: string;
	/** Comparable, searchable value behind the cell: it makes the column sortable and scanned by `globalFilter`. */
	readonly value?: ((row: Row) => string | number | null) | undefined;
	readonly cell: (row: Row) => OctaneNode;
}

export interface TableEmpty {
	readonly icon: string;
	readonly title: string;
	readonly hint?: OctaneNode;
	readonly code?: string | undefined;
}

export interface TableAction {
	readonly id: string;
	readonly label: string;
	readonly icon?: string | undefined;
	readonly tone?: 'default' | 'danger' | undefined;
	readonly disabled?: boolean | undefined;
	readonly onSelect: () => void;
}

export interface TablePagination {
	/** Zero-based index of the page on screen. */
	readonly pageIndex: number;
	readonly pageSize: number;
	/** The page the table clamped to, reported once the render commits. It moves the page for no other reason. */
	readonly onPageChange: (pageIndex: number) => void;
	/** Rows behind the table when `rows` is already one page. Omit to page client-side over `rows`. */
	readonly totalRows?: number | undefined;
}

export interface TableProps<Row extends RowData> {
	readonly columns: readonly TableColumn<Row>[];
	readonly rows: readonly Row[];
	readonly rowKey: (row: Row) => string;
	/** 'loading' replaces the body with the loading row; the screen decides when. */
	readonly status?: TableStatus | undefined;
	readonly loadingLabel?: string | undefined;
	readonly empty: TableEmpty;
	/** A search term or filter is narrowing the set, so `emptyFiltered` applies. */
	readonly filtered?: boolean | undefined;
	readonly emptyFiltered?: TableEmpty | undefined;
	/** Sortable headers for every column that declares `value`. */
	readonly sorting?: boolean | undefined;
	/** Controlled sorting state; omit to let the table keep its own. */
	readonly sortingState?: readonly TableSort[] | undefined;
	/** Every sort change, controlled or not. */
	readonly onSortingChange?: TableSortChange | undefined;
	/** Narrows rows to those whose `value` columns contain this text. */
	readonly globalFilter?: string | undefined;
	/** Slices rows to one page. Pair it with a `Pagination` in the card's `after`. */
	readonly pagination?: TablePagination | undefined;
	/** Actions rendered as compact buttons in the trailing column. */
	readonly actions?: ((row: Row) => readonly TableAction[]) | undefined;
	/** Accessible name for the otherwise visually empty action-column header. */
	readonly actionsLabel?: string | undefined;
	/** Stable width for the action column. Increase it when rows have two actions. */
	readonly actionsWidth?: string | undefined;
	readonly onSelect?: ((row: Row) => void) | undefined;
	readonly selectedKey?: string | undefined;
	/** Accessible name for the table, rendered as its aria-label. */
	readonly caption?: string | undefined;
}

interface FlowdularColumnMeta {
	readonly numeric?: boolean;
	readonly width?: string;
	readonly actions?: boolean;
	readonly actionsLabel?: string;
}

/* Sorting and filtering are stitched in statically because the feature set is
   fixed when the table is constructed. Each stage stays inert for a screen
   that did not ask for it through its manual* option, so a table without these
   props renders exactly the rows it is given. `rowPaginationFeature` carries
   no row model: it is registered for `manualPagination`, which keeps the
   filtered and sorted models from resetting a page the engine does not own. */
const FEATURES = tableFeatures({
	coreRowModel: createCoreRowModel(),
	columnFilteringFeature,
	globalFilteringFeature,
	filteredRowModel: createFilteredRowModel(),
	rowSortingFeature,
	sortedRowModel: createSortedRowModel(),
	rowPaginationFeature,
	columnMeta: {} as FlowdularColumnMeta,
});

function ActionButtons(props: { readonly actions: readonly TableAction[] }) @{
	const entries = props.actions.map((action) => ({ key: action.id, action }));
	@if (entries.length > 0) {
		<div
			class="ui-table-action-buttons"
			onClick={(event: MouseEvent) => event.stopPropagation()}
		>
			@for (const entry of entries; key entry.key) {
				<Button
					size="sm"
					variant={entry.action.tone === 'danger' ? 'danger' : 'secondary'}
					disabled={entry.action.disabled ?? false}
					onClick={entry.action.onSelect}
				>
					@if (entry.action.icon) {
						<Icon name={entry.action.icon} size={16} />
					}
					{entry.action.label}
				</Button>
			}
		</div>
	}
}

function SortIndicator(props: { readonly direction: 'asc' | 'desc' | false }) @{
	<span
		class={[
			'ui-table__sort-icon',
			props.direction !== false && 'ui-table__sort-icon--on',
			props.direction === 'asc' && 'ui-table__sort-icon--asc',
		]}
	>
		<Icon
			name={props.direction === false ? 'sort' : 'chevron-down'}
			size={14}
		/>
	</span>
}

function tanstackColumns<Row extends RowData>(
	columns: readonly TableColumn<Row>[],
	actions: ((row: Row) => readonly TableAction[]) | undefined,
	actionsLabel: string,
	actionsWidth: string,
): readonly ColumnDef<typeof FEATURES, Row>[] {
	const definitions: ColumnDef<typeof FEATURES, Row>[] = columns.map((
		column,
	) => {
		const meta = {
			numeric: column.numeric ?? false,
			width: column.width,
		};
		const value = column.value;
		if (!value) return {
			id: column.key,
			header: column.header,
			cell: (context) => column.cell(context.row.original),
			meta,
		};
		return {
			id: column.key,
			accessorFn: (row: Row) => value(row),
			header: column.header,
			cell: (context) => column.cell(context.row.original),
			sortFn: (rowA, rowB, columnId) => compareCellValues(
				rowA.getValue(columnId),
				rowB.getValue(columnId),
			),
			meta,
		};
	});
	if (actions) {
		definitions.push({
			id: '__actions',
			header: '',
			cell: (context) =>
				<ActionButtons actions={actions(context.row.original)} />,
			meta: {
				actions: true,
				actionsLabel,
				width: actionsWidth,
			},
		});
	}
	return definitions;
}

function rowClass(clickable: boolean, selected: boolean): string | false {
	if (clickable) return selected ? 'is-clickable is-selected' : 'is-clickable';
	return selected && 'is-selected';
}

function widthStyle(width: string | undefined): string {
	return width === undefined ? '' : `width: ${width};`;
}

function ariaSort(
	direction: 'asc' | 'desc' | false,
	sortable: boolean,
): 'ascending' | 'descending' | 'none' | undefined {
	if (direction === 'asc') return 'ascending';
	if (direction === 'desc') return 'descending';
	return sortable ? 'none' : undefined;
}

/**
 * Flowdular's visual table over the official TanStack Table v9 adapter for
 * Octane. Screens keep the small Flowdular contract while TanStack owns the
 * row, header, column and cell model underneath it.
 */
export function Table<Row extends RowData>(props: TableProps<Row>) @{
	const columns = tanstackColumns(
		props.columns,
		props.actions,
		props.actionsLabel ?? '',
		props.actionsWidth ?? '160px',
	);
	const sortable = props.sorting === true;
	const [ownSorting, setOwnSorting] = useState<readonly TableSort[]>([]);
	const sorts = props.sortingState ?? ownSorting;
	const signature = sortingSignature(sorts);
	/* The engine compares external state slices by reference, so a fresh array
   on every render would write its atom mid-render. Rebuild only on a real
   sort change. */
	const engineSorting = useMemo(
		() => sorts.map((sort) => ({ id: sort.key, desc: sort.desc })),
		[signature],
	);
	const pagination = props.pagination;
	/* The module paginated in SQL, so `rows` is already the page on screen. */
	const serverPaged = pagination?.totalRows !== undefined;
	const table = useTable({
		features: FEATURES,
		data: props.rows,
		columns,
		getRowId: (row) => props.rowKey(row),
		enableSorting: sortable,
		manualSorting: !sortable,
		manualFiltering: props.globalFilter === undefined,
		/* The engine filters and sorts; the page window is taken below. The row
   count to clamp a page index against exists only once the engine has
   filtered, so a page slice fed back into the engine would have to be
   computed before the number it depends on. */
		manualPagination: true,
		getColumnCanGlobalFilter: () => true,
		state: {
			...(sortable ? { sorting: engineSorting } : {}),
			...(props.globalFilter === undefined
				? {}
				: { globalFilter: props.globalFilter }),
		},
		...(sortable
			? {
					onSortingChange: (updater) => {
						const next =
							typeof updater === 'function' ? updater(engineSorting) : updater;
						const mapped = next.map(
							(sort) => ({
								key: sort.id,
								desc: sort.desc,
							}),
						);
						if (props.sortingState === undefined) setOwnSorting(mapped);
						props.onSortingChange?.(mapped);
					},
				}
			: {}),
	});
	const pagedRows = table.getRowModel().rows;
	const range = pageRange(
		pagination?.totalRows ?? pagedRows.length,
		pagination?.pageSize ?? 1,
		pagination?.pageIndex ?? 0,
	);
	/* The table owns no page of its own: it clamps for this render and tells the
   screen once the render commits, so a row set that shrinks under the reader
   never updates the screen's state from inside the render. */
	useEffect(() => {
		if (
			pagination && range.pageIndex !== pagination.pageIndex
		) pagination.onPageChange(range.pageIndex);
	}, [range.pageIndex, pagination?.pageIndex]);
	/* `from` and `to` are the same one-based positions the pager reads, so the
   rows on screen and the reading under them can never disagree. */
	const windowRows =
		pagination && !serverPaged
			? pagedRows.slice(Math.max(0, range.from - 1), range.to)
			: pagedRows;
	const narrowed = props.filtered === true || (props.globalFilter ?? '') !== '';
	const empty = narrowed && props.emptyFiltered || props.empty;
	const span = columns.length;
	/* TanStack row/header/cell objects are live compatibility objects. Render
   them here and carry immutable values into keyed TSRX loops. */
	const headerGroups = table.getHeaderGroups().map(
		(group) => ({
			key: group.id,
			headers: group.headers.map((header) => {
				const meta = header.column.columnDef.meta as FlowdularColumnMeta | undefined;
				const canSort = header.column.getCanSort();
				const direction =
					canSort ? header.column.getIsSorted() : false;
				return {
					key: header.id,
					content: header.isPlaceholder
						? null
						: flexRender(header.column.columnDef.header, header.getContext()),
					meta,
					canSort,
					direction,
					sort: ariaSort(direction, canSort),
					onToggle: () => header.column.toggleSorting(),
				};
			}),
		}),
	);
	const renderedRows = windowRows.map(
		(row) => ({
			key: row.id,
			selected: props.selectedKey === row.id,
			clickable: props.onSelect !== undefined,
			onClick: () => props.onSelect?.(row.original),
			cells: row.getAllCells().map(
				(cell) => ({
					key: cell.id,
					content: flexRender(cell.column.columnDef.cell, cell.getContext()),
					meta: cell.column.columnDef.meta as FlowdularColumnMeta | undefined,
				}),
			),
		}),
	);
	const leafColumns = table.getAllLeafColumns().map(
		(column) => ({
			key: column.id,
			meta: column.columnDef.meta as FlowdularColumnMeta | undefined,
		}),
	);

	<div class="ui-table-wrap">
		<table class="ui-table" aria-label={props.caption ?? ''}>
			<colgroup>
				@for (const column of leafColumns; key column.key) {
					<col
						class={column.meta?.actions && 'ui-table__actions-column'}
						style={widthStyle(column.meta?.width)}
					/>
				}
			</colgroup>
			<thead>
				@for (const group of headerGroups; key group.key) {
					<tr>
						@for (const header of group.headers; key header.key) {
							<th
								class={[
									header.meta?.numeric && 'num',
									header.meta?.actions && 'ui-table__actions',
								]}
								style={widthStyle(header.meta?.width)}
								aria-label={header.meta?.actions
									? header.meta.actionsLabel ?? ''
									: ''}
								aria-sort={header.sort}
							>
								{header.canSort
									? <button
											class="ui-table__sort"
											type="button"
											onClick={header.onToggle}
										>
											{header.content}
											<SortIndicator direction={header.direction} />
										</button>
									: header.content}
							</th>
						}
					</tr>
				}
			</thead>
			<tbody>
				@if (props.status === 'loading') {
					<tr class="ui-table__placeholder">
						<td class="ui-table__empty" colspan={span}>
							{props.loadingLabel ?? 'Loading…'}
						</td>
					</tr>
				} @else if (renderedRows.length === 0) {
					<tr class="ui-table__placeholder">
						<td colspan={span}>
							<EmptyState
								icon={empty.icon}
								title={empty.title}
								code={empty.code ?? ''}
							>{empty.hint}</EmptyState>
						</td>
					</tr>
				} @else {
					@for (const row of renderedRows; key row.key) {
						<tr
							class={rowClass(row.clickable, row.selected)}
							onClick={row.onClick}
						>
							@for (const cell of row.cells; key cell.key) {
								<td
									class={[
										cell.meta?.numeric && 'num',
										cell.meta?.actions && 'ui-table__actions',
									]}
								>{cell.content}</td>
							}
						</tr>
					}
				}
			</tbody>
		</table>
	</div>
}
