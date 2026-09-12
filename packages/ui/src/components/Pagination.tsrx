import { Icon } from '../icons/Icon.tsrx';
import { Button } from './Button.tsrx';
import {
	keysetPage,
	pageRange,
	type KeysetPage,
	type PageRange,
} from './pagination.ts';

interface PaginationBaseProps {
	/** Zero-based index of the page on screen. */
	readonly pageIndex: number;
	readonly pageSize: number;
	readonly onPageChange: (pageIndex: number) => void;
	/** Accessible name of the pager, e.g. 'Member pages'. */
	readonly label: string;
	readonly previousLabel: string;
	readonly nextLabel: string;
}

/** The size select is one decision, so its parts cannot arrive separately. */
type PageSizeChoice =
	| {
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
	  };

/** How far the set reaches: counted, or a keyset page nobody counted. */
type PageExtent =
	| {
			/** Rows behind the table, after any filtering the screen applies. */
			readonly totalRows: number;
			readonly hasMore?: undefined;
			/** The reading beside the buttons, e.g. 'Page 2 of 5 · 26-50 of 120'. */
			readonly summary: (range: PageRange) => string;
	  }
	| {
			readonly totalRows?: undefined;
			/** Whether a page follows this one, which is all a keyset page knows. */
			readonly hasMore: boolean;
			/** The reading beside the buttons, e.g. 'From 26'. */
			readonly summary: (page: KeysetPage) => string;
	  };

export type PaginationProps = PaginationBaseProps & PageSizeChoice & PageExtent;

interface PagerReading {
	/** Zero-based index of the page on screen, clamped where a count allows it. */
	readonly pageIndex: number;
	readonly reading: string;
	/** No page follows this one, so Next is closed. */
	readonly last: boolean;
}

/* The one place the two shapes are told apart: a counted set clamps its index
   against the page count it has, and a keyset page has none to clamp against. */
function pagerReading(props: PaginationProps): PagerReading {
	if (props.totalRows === undefined) {
		const page = keysetPage(props.pageIndex, props.pageSize, props.hasMore);
		return {
			pageIndex: page.pageIndex,
			reading: props.summary(page),
			last: !page.hasMore,
		};
	}
	const range = pageRange(props.totalRows, props.pageSize, props.pageIndex);
	return {
		pageIndex: range.pageIndex,
		reading: props.summary(range),
		last: range.pageIndex >= range.pageCount - 1,
	};
}

/**
 * The pager under a `Table`, placed in the `TableCard` `after` slot. It owns
 * the page arithmetic and nothing else: the screen holds the page index and
 * size, so the table and the pager always read the same page.
 *
 * A set the screen counted pages against its total. A keyset page passes
 * `hasMore` instead: there is no page count, so the reading carries none and
 * Next stays open exactly while another page follows.
 */
export function Pagination(props: PaginationProps) @{
	const page = pagerReading(props);
	const sizes = props.pageSizes ?? [];
	const onPageSizeChange = props.onPageSizeChange;
	<nav class="ui-pagination" aria-label={props.label}>
		<span class="ui-pagination__summary">{page.reading}</span>
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
				disabled={page.pageIndex <= 0}
				onClick={() => props.onPageChange(page.pageIndex - 1)}
			>
				<Icon name="chevron-left" size={14} />
				{props.previousLabel}
			</Button>
			<Button
				size="sm"
				disabled={page.last}
				onClick={() => props.onPageChange(page.pageIndex + 1)}
			>
				{props.nextLabel}
				<Icon name="chevron-right" size={14} />
			</Button>
		</div>
	</nav>
}
