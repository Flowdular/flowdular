import {
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from 'octane';
import type { OctaneNode } from 'octane';
import {
	columnFilteringFeature,
	createCoreRowModel,
	createFilteredRowModel,
	createSortedRowModel,
	flexRender,
	globalFilteringFeature,
	rowPaginationFeature,
	rowSelectionFeature,
	rowSortingFeature,
	tableFeatures,
	useTable,
	type ColumnDef,
	type RowData,
	type RowSelectionState,
} from '@octanejs/tanstack-table';
import { Icon } from '../icons/Icon.tsrx';
import { ActionMenu } from './ActionMenu.tsrx';
import { Button } from './Button.tsrx';
import { EmptyState } from './EmptyState.tsrx';
import { pageRange } from './pagination.ts';
import {
	actionsFold,
	SELECT_WIDTH,
	tableLayout,
	type TableActionsFold,
	type TablePriority,
} from './table-layout.ts';
import { CellControlsContext, TableLocaleContext } from './table-locale.ts';
import {
	compareCellValues,
	sortingSignature,
	type TableSort,
	type TableSortChange,
} from './table-sorting.ts';

export type TableStatus = 'idle' | 'loading';

/** 'server' means the module already sorted, narrowed and paged in SQL. */
export type TableMode = 'client' | 'server';

export interface TableColumn<Row extends RowData> {
	readonly key: string;
	readonly header: string;
	/** Tabular figures, right aligned: the th and td carry `num`. */
	readonly numeric?: boolean | undefined;
	/** Required CSS width: px for a bounded column (time, status, number, tag), 'auto' for the one column that takes the rest. */
	readonly width: string;
	/** 1 (default) always shows; 2 hides in a narrow table; 3 hides first. The first column is always 1. A hidden column is listed in the row's expanded details. */
	readonly priority?: TablePriority | undefined;
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
	/** Why this action is refused. Read only while `disabled`, as the button's accessible description. */
	readonly reason?: string | undefined;
	readonly onSelect: () => void;
}

export interface TableSelection<Row extends RowData> {
	/** Controlled by the screen, which resets it on a page, sort or filter change. The header checkbox touches only the rows on screen; the clear button empties the whole set. */
	readonly selectedKeys: ReadonlySet<string>;
	readonly onSelectionChange: (keys: ReadonlySet<string>) => void;
	/** Accessible name of the header checkbox. */
	readonly label: string;
	/** Accessible name of a row's checkbox. */
	readonly rowLabel: (row: Row) => string;
	/** false: the row has no checkbox and the header checkbox skips it. */
	readonly selectable?: ((row: Row) => boolean) | undefined;
	/** Label of the clear-selection button in the bulk bar. */
	readonly clearLabel?: string | undefined;
}

export interface TableBulkAction {
	readonly id: string;
	readonly label: string;
	readonly icon?: string | undefined;
	readonly tone?: 'default' | 'danger' | undefined;
	readonly disabled?: boolean | undefined;
	/** Why this action is refused. Read only while `disabled`, like `TableAction.reason`. */
	readonly reason?: string | undefined;
	readonly onSelect: (keys: readonly string[]) => void;
}

export interface TablePagination {
	/** Zero-based index of the page on screen. */
	readonly pageIndex: number;
	readonly pageSize: number;
	/** The page the table clamped to, reported once the render commits. It moves the page for no other reason. */
	readonly onPageChange: (pageIndex: number) => void;
	/** Rows behind the table when `rows` is already one page. Omit to page client-side over `rows`, or, in server mode, for a keyset page nobody counted. */
	readonly totalRows?: number | undefined;
	/** Whether a page follows this one. Read only when `totalRows` is absent: a keyset page knows there is more without knowing how much. */
	readonly hasMore?: boolean | undefined;
}

export interface TableProps<Row extends RowData> {
	readonly columns: readonly TableColumn<Row>[];
	readonly rows: readonly Row[];
	readonly rowKey: (row: Row) => string;
	/** 'server' renders `rows` as they arrive and reports every sort and page change instead of narrowing. */
	readonly mode?: TableMode | undefined;
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
	/** Actions in the trailing column: up to two as compact buttons that fold into a More menu in a narrow table, more than two always in the menu. */
	readonly actions?: ((row: Row) => readonly TableAction[]) | undefined;
	/** Accessible name for the otherwise visually empty action-column header. */
	readonly actionsLabel?: string | undefined;
	/** Stable width for the action column while its buttons show. Increase it when rows have two actions. */
	readonly actionsWidth?: string | undefined;
	readonly onSelect?: ((row: Row) => void) | undefined;
	readonly selectedKey?: string | undefined;
	/** Multi-row selection through a leading checkbox column. The header checkbox toggles the rows on screen. */
	readonly selection?: TableSelection<Row> | undefined;
	/** Buttons in the bar above the table while at least one row is selected. */
	readonly bulkActions?: readonly TableBulkAction[] | undefined;
	/** Text of the bulk bar and the polite announcement, e.g. "3 selected". */
	readonly selectionSummary?: ((count: number) => string) | undefined;
	/** Accessible name for the table, rendered as its aria-label. */
	readonly caption?: string | undefined;
}

interface FlowdularColumnMeta {
	readonly numeric?: boolean;
	readonly width?: string;
	readonly title?: string;
	readonly priority?: TablePriority;
	/** The first column, which holds the expand and open buttons. */
	readonly lead?: boolean;
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
	rowSelectionFeature,
	columnMeta: {} as FlowdularColumnMeta,
});

const SELECT_COLUMN_WIDTH = SELECT_WIDTH + 'px';
const ACTIONS_COLUMN_WIDTH = 'width: var(--ui-table-actions-fold, var(--ui-table-actions-width));';

function defaultSelectionSummary(count: number): string {
	return count + ' selected';
}

/* A checkbox answers Space on its own; Enter is added so both keys the row
   contract names toggle the same way. */
function enterToggles(toggle: () => void): (event: KeyboardEvent) => void {
	return (event) => {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		toggle();
	};
}

function stopClick(event: MouseEvent): void {
	event.stopPropagation();
}

function SelectAll(props: {
	readonly label: string;
	readonly checked: boolean;
	readonly mixed: boolean;
	readonly disabled: boolean;
	readonly onToggle: () => void;
}) @{
	const ref = useRef<HTMLInputElement | null>(null);
	/* Every render: a click the screen ignored has already cleared the native
   flag while `mixed` still holds. */
	useEffect(() => {
		if (ref.current) ref.current.indeterminate = props.mixed;
	});

	<input
		type="checkbox"
		ref={ref}
		aria-label={props.label}
		aria-checked={props.mixed
			? 'mixed'
			: props.checked
				? 'true'
				: 'false'}
		checked={props.checked}
		disabled={props.disabled}
		onChange={props.onToggle}
		onKeyDown={enterToggles(props.onToggle)}
	/>
}

function ActionButtons(props: { readonly actions: readonly TableAction[] }) @{
	const base = useId();
	/* A reason answers "why can I not do this", so it is read only while the
   action is refused; an enabled action pays for no description node. */
	const entries = props.actions.map((action) => {
		const reason =
			action.disabled === true ? action.reason ?? '' : '';
		return {
			key: action.id,
			action,
			reason,
			reasonId: reason === '' ? undefined : base + '-' + action.id,
		};
	});
	@if (entries.length > 0) {
		<div
			class="ui-table-action-buttons"
			onClick={(event: MouseEvent) => event.stopPropagation()}
		>
			@for (const entry of entries; key entry.key) {
				<span
					class="ui-table-action"
					title={entry.reason === '' ? undefined : entry.reason}
				>
					<Button
						size="sm"
						variant={entry.action.tone === 'danger' ? 'danger' : 'secondary'}
						disabled={entry.action.disabled ?? false}
						describedBy={entry.reasonId}
						onClick={entry.action.onSelect}
					>
						@if (entry.action.icon) {
							<Icon name={entry.action.icon} size={16} />
						}
						{entry.action.label}
					</Button>
					@if (entry.reasonId) {
						<span
							class="ui-visually-hidden"
							id={entry.reasonId}
						>{entry.reason}</span>
					}
				</span>
			}
		</div>
	}
}

function RowActions(props: {
	readonly actions: readonly TableAction[];
	readonly fold: TableActionsFold;
	readonly label: string;
}) @{
	@if (props.fold === 'always') {
		<ActionMenu
			actions={props.actions}
			label={props.label}
			triggerClass="ui-table-more--always"
		/>
	} @else if (props.fold === 'narrow') {
		<>
			<ActionButtons actions={props.actions} />
			<ActionMenu actions={props.actions} label={props.label} />
		</>
	} @else {
		<ActionButtons actions={props.actions} />
	}
}

/* The first cell of a row: the expand button while a narrow table hides a
   column, and the open button that makes a clickable row reachable from the
   keyboard. A table with neither renders the cell as it is. */
function LeadCell(props: {
	readonly content: OctaneNode;
	readonly collapsible: boolean;
	readonly expanded: boolean;
	readonly detailsId: string;
	readonly onToggle: () => void;
	readonly clickable: boolean;
	readonly expandLabel: string;
	readonly collapseLabel: string;
}) @{
	const label = props.expanded ? props.collapseLabel : props.expandLabel;
	@if (!props.collapsible && !props.clickable) {
		<>
			{props.content}
		</>
	} @else {
		<span class="ui-table__lead">
			@if (props.collapsible) {
				<button
					class="ui-table__toggle"
					type="button"
					aria-expanded={props.expanded}
					aria-controls={props.expanded ? props.detailsId : undefined}
					aria-label={label}
					title={label}
					onClick={(event: MouseEvent) => {
						event.stopPropagation();
						props.onToggle();
					}}
				>
					<Icon name="chevron-right" size={16} />
				</button>
			}
			@if (props.clickable) {
				<CellControlsContext.Provider value={false}>
					<button class="ui-table__open" type="button">{props.content}</button>
				</CellControlsContext.Provider>
			} @else {
				<span class="ui-table__lead-body">{props.content}</span>
			}
		</span>
	}
}

function priorityClass(priority: TablePriority | undefined): string | false {
	return priority !== undefined && priority > 1 && 'ui-table__p' + priority;
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
		index,
	) => {
		const meta = {
			numeric: column.numeric ?? false,
			width: column.width,
			title: column.header,
			priority: index === 0 ? 1 : column.priority ?? 1,
			lead: index === 0,
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
		/* The cell is rendered by the table, which knows how every row folds. */
		definitions.push({
			id: '__actions',
			header: '',
			cell: () => null,
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
	const selection = props.selection;
	const selectedKeys = selection?.selectedKeys;
	/* Same reference rule as sorting: the engine's selection slice is rebuilt
   only when the set of keys changed, never for a Set the screen recreated. */
	const selectionSignature =
		selectedKeys === undefined ? '' : [...selectedKeys].sort().join('\n');
	const rowSelection = useMemo<RowSelectionState>(() => {
		const state: Record<string, true> = {};
		if (selectedKeys) for (const key of selectedKeys) state[key] = true;
		return state;
	}, [selectionSignature]);
	const pagination = props.pagination;
	/* Server mode: the module sorted, narrowed and cut the page in SQL, so every
   stage here stays inert and the header and pager only report. */
	const server = props.mode === 'server';
	const table = useTable({
		features: FEATURES,
		data: props.rows,
		columns,
		getRowId: (row) => props.rowKey(row),
		enableSorting: sortable,
		manualSorting: server || !sortable,
		manualFiltering: server || props.globalFilter === undefined,
		/* The engine filters and sorts; the page window is taken below. The row
   count to clamp a page index against exists only once the engine has
   filtered, so a page slice fed back into the engine would have to be
   computed before the number it depends on. */
		manualPagination: true,
		getColumnCanGlobalFilter: () => true,
		enableRowSelection: selection === undefined
			? false
			: (row) => selection.selectable?.(row.original) ?? true,
		state: {
			...(sortable ? { sorting: engineSorting } : {}),
			...(props.globalFilter === undefined
				? {}
				: { globalFilter: props.globalFilter }),
			...(selection === undefined ? {} : { rowSelection }),
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
	/* A keyset page was never counted, so there is no total to clamp against and
   `hasMore` is all the table knows about what is behind it. */
	const total = server
		? pagination?.totalRows
		: pagination?.totalRows ?? pagedRows.length;
	const range =
		pagination !== undefined && total !== undefined
			? pageRange(total, pagination.pageSize, pagination.pageIndex)
			: undefined;
	/* The table owns no page of its own: it clamps for this render and tells the
   screen once the render commits, so a row set that shrinks under the reader
   never updates the screen's state from inside the render. */
	useEffect(() => {
		if (!pagination) return;
		if (range) {
			if (range.pageIndex !== pagination.pageIndex) pagination.onPageChange(
				range.pageIndex,
			);
			return;
		}
		/* An empty keyset page with nothing behind it is the only proof the
	   reader walked off the end of the set. A page still waiting on its rows is
	   not that proof: it is empty because the request is in flight. */
		if (
			props.status !== 'loading' && pagination.pageIndex > 0 &&
				pagedRows.length === 0 &&
				pagination.hasMore !== true
		) pagination.onPageChange(pagination.pageIndex - 1);
	}, [range?.pageIndex, pagination?.pageIndex, pagedRows.length, props.status]);
	/* The module paginated in SQL, so `rows` is already the page on screen. */
	const prePaged = server || pagination?.totalRows !== undefined;
	/* `from` and `to` are the same one-based positions the pager reads, so the
   rows on screen and the reading under them can never disagree. */
	const windowRows =
		range !== undefined && !prePaged
			? pagedRows.slice(Math.max(0, range.from - 1), range.to)
			: pagedRows;
	const narrowed = props.filtered === true || (props.globalFilter ?? '') !== '';
	const empty = narrowed && props.emptyFiltered || props.empty;
	const span = columns.length + (selection === undefined ? 0 : 1);
	const change = (keys: readonly string[], checked: boolean) => {
		if (!selection) return;
		const next = new Set(selection.selectedKeys);
		for (const key of keys) {
			if (checked) next.add(key);
			else next.delete(key);
		}
		selection.onSelectionChange(next);
	};
	/* The header checkbox covers exactly the rows on screen: in server mode that
   is the page the module gave, never the whole set behind it. */
	const selectableRows =
		selection === undefined
			? []
			: windowRows.filter((row) => row.getCanSelect());
	const checkedOnScreen = selectableRows.filter(
		(row) => row.getIsSelected(),
	).length;
	const allChecked =
		selectableRows.length > 0 && checkedOnScreen === selectableRows.length;
	const toggleAll = () => change(
		selectableRows.map((row) => row.id),
		!allChecked,
	);
	const selectedCount = selectedKeys?.size ?? 0;
	const summarize = props.selectionSummary ?? defaultSelectionSummary;
	const summary = summarize(selectedCount);
	const bulk = (props.bulkActions ?? []).map(
		(action): TableAction => ({
			...action,
			onSelect: () => action.onSelect([...(selectedKeys ?? [])]),
		}),
	);
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
	const copy = useContext(TableLocaleContext);
	const detailsBase = useId();
	const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(
		new Set(),
	);
	const toggleExpanded = (key: string) => {
		const next = new Set(expandedKeys);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		setExpandedKeys(next);
	};
	const rowActions = props.actions;
	const renderedRows = windowRows.map(
		(row, index) => ({
			key: row.id,
			selected: props.selectedKey === row.id,
			clickable: props.onSelect !== undefined,
			onClick: () => props.onSelect?.(row.original),
			selectable: row.getCanSelect(),
			checked: row.getIsSelected(),
			checkLabel: selection?.rowLabel(row.original) ?? '',
			onCheck: (checked: boolean) => change([row.id], checked),
			actions: rowActions ? rowActions(row.original) : [],
			expanded: expandedKeys.has(row.id),
			detailsId: detailsBase + '-details-' + index,
			original: row.original,
			cells: row.getAllCells().map(
				(cell) => ({
					key: cell.id,
					content: flexRender(cell.column.columnDef.cell, cell.getContext()),
					meta: cell.column.columnDef.meta as FlowdularColumnMeta | undefined,
				}),
			),
		}),
	);
	/* How the actions fold follows the most actions any row on screen offers.
   A table between two loads keeps the fold it had, so a refresh or a filter
   down to nothing does not move the columns. */
	const foldRef = useRef<TableActionsFold>('never');
	if (renderedRows.length > 0) foldRef.current = actionsFold(
		Math.max(...renderedRows.map((row) => row.actions.length)),
	);
	const fold = rowActions ? foldRef.current : 'never';
	const layout = tableLayout({
		columns: props.columns.map(
			(column, index) => ({
				width: column.width,
				priority: index === 0 ? 1 : column.priority ?? 1,
			}),
		),
		selection: selection !== undefined,
		actionsWidth: rowActions ? props.actionsWidth ?? '160px' : undefined,
		fold,
	});
	/* One entry per table row, so every loop step renders exactly one <tr>: an
   expanded row is followed by its details. */
	const entries = renderedRows.flatMap(
		(row) => layout.collapsible && row.expanded
			? [
					{ key: 'row:' + row.key, row, details: false },
					{ key: 'details:' + row.key, row, details: true },
				]
			: [
					{ key: 'row:' + row.key, row, details: false },
				],
	);
	/* The details cell spans only columns that never hide: a span over a hidden
   column would make the table grow a column that is not there. Its list is as
   wide as the wrapper instead. */
	const detailsSpan =
		(selection === undefined ? 0 : 1) + (rowActions ? 1 : 0) +
		props.columns.filter(
			(column, index) => index === 0 || (column.priority ?? 1) === 1,
		).length;
	const detailColumns = props.columns.filter(
		(column, index) => index > 0 && (column.priority ?? 1) > 1,
	);
	const leafColumns = table.getAllLeafColumns().map(
		(column) => ({
			key: column.id,
			meta: column.columnDef.meta as FlowdularColumnMeta | undefined,
		}),
	);

	<>
		@if (selection) {
			<div class="ui-visually-hidden" aria-live="polite">{summary}</div>
		}
		@if (selection && selectedCount > 0) {
			<div class="ui-table__bulk">
				<span class="ui-table__bulk-count">{summary}</span>
				<ActionButtons actions={bulk} />
				<Button
					size="sm"
					variant="ghost"
					onClick={() => selection.onSelectionChange(new Set())}
				>
					{selection.clearLabel ?? 'Clear selection'}
				</Button>
			</div>
		}
		<div class="ui-table-wrap">
			<table
				class={['ui-table', ...layout.classes]}
				aria-label={props.caption ?? ''}
				style={'min-width: ' + String(layout.minWidth) + 'px;' +
					(rowActions
						? ' --ui-table-actions-width: ' + String(layout.actionsWidth) +
							'px;'
						: '')}
			>
				<colgroup>
					@if (selection) {
						<col
							class="ui-table__select-column"
							style={widthStyle(SELECT_COLUMN_WIDTH)}
						/>
					}
					@for (const column of leafColumns; key column.key) {
						<col
							class={[
								column.meta?.actions && 'ui-table__actions-column',
								priorityClass(column.meta?.priority),
							]}
							style={column.meta?.actions
								? ACTIONS_COLUMN_WIDTH
								: widthStyle(column.meta?.width)}
						/>
					}
				</colgroup>
				<thead>
					@for (const group of headerGroups; key group.key) {
						<tr>
							@if (selection) {
								<th
									class="ui-table__select"
									style={widthStyle(SELECT_COLUMN_WIDTH)}
								>
									<SelectAll
										label={selection.label}
										checked={allChecked}
										mixed={checkedOnScreen > 0 && !allChecked}
										disabled={selectableRows.length === 0}
										onToggle={toggleAll}
									/>
								</th>
							}
							@for (const header of group.headers; key header.key) {
								<th
									class={[
										header.meta?.numeric && 'num',
										header.meta?.actions && 'ui-table__actions',
										priorityClass(header.meta?.priority),
									]}
									style={header.meta?.actions
										? ''
										: widthStyle(header.meta?.width)}
									title={header.meta?.actions ? undefined : header.meta?.title}
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
						@for (const entry of entries; key entry.key) {
							@if (entry.details) {
								<tr class="ui-table__details" id={entry.row.detailsId}>
									<td colspan={detailsSpan}>
										<dl class="ui-table__details-list">
											@for (const column of detailColumns; key column.key) {
												<div
													class={[
														'ui-table__detail',
														'ui-table__detail--p' + String(column.priority),
													]}
												>
													<dt>{column.header}</dt>
													<dd class={column.numeric && 'num'}>{column.cell(
														entry.row.original,
													)}</dd>
												</div>
											}
										</dl>
									</td>
								</tr>
							} @else {
								<tr
									class={rowClass(entry.row.clickable, entry.row.selected)}
									aria-selected={selection === undefined
										? undefined
										: entry.row.checked
											? 'true'
											: 'false'}
									onClick={entry.row.onClick}
								>
									@if (selection) {
										<td class="ui-table__select" onClick={stopClick}>
											@if (entry.row.selectable) {
												<input
													type="checkbox"
													aria-label={entry.row.checkLabel}
													checked={entry.row.checked}
													onChange={(event: Event) => entry.row.onCheck(
														(event.currentTarget as HTMLInputElement).checked,
													)}
													onKeyDown={enterToggles(
														() => entry.row.onCheck(!entry.row.checked),
													)}
												/>
											}
										</td>
									}
									@for (const cell of entry.row.cells; key cell.key) {
										<td
											class={[
												cell.meta?.numeric && 'num',
												cell.meta?.actions && 'ui-table__actions',
												priorityClass(cell.meta?.priority),
											]}
										>
											@if (cell.meta?.actions) {
												<RowActions
													actions={entry.row.actions}
													fold={fold}
													label={copy.moreActions}
												/>
											} @else if (cell.meta?.lead) {
												<LeadCell
													content={cell.content}
													collapsible={layout.collapsible}
													expanded={entry.row.expanded}
													detailsId={entry.row.detailsId}
													onToggle={() => toggleExpanded(entry.row.key)}
													clickable={entry.row.clickable}
													expandLabel={copy.expand}
													collapseLabel={copy.collapse}
												/>
											} @else {
												<>
													{cell.content}
												</>
											}
										</td>
									}
								</tr>
							};
						}
					}
				</tbody>
			</table>
		</div>
	</>
}
