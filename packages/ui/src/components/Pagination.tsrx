import { Icon } from '../icons/Icon.tsrx';
import { Button } from './Button.tsrx';
import { pageRange, type PageRange } from './pagination.ts';

interface PaginationBaseProps {
	/** Zero-based index of the page on screen. */
	readonly pageIndex: number;
	readonly pageSize: number;
	/** Rows behind the table, after any filtering the screen applies. */
	readonly totalRows: number;
	readonly onPageChange: (pageIndex: number) => void;
	/** Accessible name of the pager, e.g. 'Member pages'. */
	readonly label: string;
	readonly previousLabel: string;
	readonly nextLabel: string;
	/** The reading beside the buttons, e.g. 'Page 2 of 5 · 26-50 of 120'. */
	readonly summary: (range: PageRange) => string;
}

/** The size select is one decision, so its parts cannot arrive separately. */
export type PaginationProps =
	PaginationBaseProps & (| {
			/** Offered page sizes. Omit the pair to fix the size and hide the select. */
			readonly pageSizes: readonly number[];
			readonly onPageSizeChange: (pageSize: number) => void;
			/** Accessible name of the select; it carries no visible label. */
			readonly pageSizeLabel?: string | undefined;
	  }
	| {
			readonly pageSizes?: undefined;
			readonly onPageSizeChange?: undefined;
			readonly pageSizeLabel?: undefined;
	  });

/**
 * The pager under a `Table`, placed in the `TableCard` `after` slot. It owns
 * the page arithmetic and nothing else: the screen holds the page index and
 * size, so the table and the pager always read the same page.
 */
export function Pagination(props: PaginationProps) @{
	const range = pageRange(props.totalRows, props.pageSize, props.pageIndex);
	const sizes = props.pageSizes ?? [];
	const onPageSizeChange = props.onPageSizeChange;
	<nav class="ui-pagination" aria-label={props.label}>
		<span class="ui-pagination__summary">{props.summary(range)}</span>
		@if (sizes.length > 0) {
			<select
				class="ui-select ui-pagination__size"
				value={String(props.pageSize)}
				aria-label={props.pageSizeLabel ?? props.label}
				onInput={(event) => onPageSizeChange?.(
					Number(event.currentTarget.value),
				)}
			>
				@for (const size of sizes; key size) {
					<option value={String(size)}>{String(size)}</option>
				}
			</select>
		}
		<div class="ui-pagination__pages">
			<Button
				size="sm"
				disabled={range.pageIndex <= 0}
				onClick={() => props.onPageChange(range.pageIndex - 1)}
			>
				<Icon name="chevron-left" size={14} />
				{props.previousLabel}
			</Button>
			<Button
				size="sm"
				disabled={range.pageIndex >= range.pageCount - 1}
				onClick={() => props.onPageChange(range.pageIndex + 1)}
			>
				{props.nextLabel}
				<Icon name="chevron-right" size={14} />
			</Button>
		</div>
	</nav>
}
