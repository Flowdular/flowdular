import type { OctaneNode } from 'octane';
import {
	createCoreRowModel,
	flexRender,
	tableFeatures,
	useTable,
	type ColumnDef,
	type RowData,
} from '@octanejs/tanstack-table';
import { Icon } from '../icons/Icon.tsrx';
import { Button } from './Button.tsrx';
import { EmptyState } from './EmptyState.tsrx';

export type TableStatus = 'idle' | 'loading';

export interface TableColumn<Row extends RowData> {
	readonly key: string;
	readonly header: string;
	/** Tabular figures, right aligned: the th and td carry `num`. */
	readonly numeric?: boolean | undefined;
	/** Required CSS width, e.g. '120px' or '20%', to prevent layout drift. */
	readonly width: string;
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

const FEATURES = tableFeatures({
	coreRowModel: createCoreRowModel(),
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

function tanstackColumns<Row extends RowData>(
	columns: readonly TableColumn<Row>[],
	actions: ((row: Row) => readonly TableAction[]) | undefined,
	actionsLabel: string,
	actionsWidth: string,
): readonly ColumnDef<typeof FEATURES, Row>[] {
	const definitions: ColumnDef<typeof FEATURES, Row>[] = columns.map(
		(column) => ({
			id: column.key,
			header: column.header,
			cell: (context) => column.cell(context.row.original),
			meta: {
				numeric: column.numeric ?? false,
				width: column.width,
			},
		}),
	);
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
	const table = useTable({
		features: FEATURES,
		data: props.rows,
		columns,
		getRowId: (row) => props.rowKey(row),
	});
	const empty = props.filtered && props.emptyFiltered || props.empty;
	const span = columns.length;
	/* TanStack row/header/cell objects are live compatibility objects. Render
   them here and carry immutable values into keyed TSRX loops. */
	const headerGroups = table.getHeaderGroups().map(
		(group) => ({
			key: group.id,
			headers: group.headers.map((header) => {
				const meta = header.column.columnDef.meta as FlowdularColumnMeta | undefined;
				return {
					key: header.id,
					content: header.isPlaceholder
						? null
						: flexRender(header.column.columnDef.header, header.getContext()),
					meta,
				};
			}),
		}),
	);
	const renderedRows = table.getRowModel().rows.map(
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
							>{header.content}</th>
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
