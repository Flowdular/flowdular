import { describe, expect, it, vi } from 'vitest';
import {
	Pagination,
	type PaginationProps,
} from '../src/components/Pagination.tsrx';
import { mount, run, text } from './dom.ts';

function summary(range: {
	readonly pageIndex: number;
	readonly pageCount: number;
	readonly from: number;
	readonly to: number;
	readonly totalRows: number;
}): string {
	return `${
		range.pageIndex + 1
	} of ${range.pageCount} · ${range.from}-${range.to} of ${range.totalRows}`;
}

function buttons(container: HTMLElement): readonly HTMLButtonElement[] {
	return Array.from(container.querySelectorAll('.ui-pagination__pages button'));
}

const PAGER = {
	pageIndex: 0,
	pageSize: 25,
	totalRows: 120,
	onPageChange: () => {},
	label: 'Member pages',
	previousLabel: 'Previous',
	nextLabel: 'Next',
	summary,
};

/* The size select is one decision, so half of it must not compile. `tsrx-tsc`
   over `tests/**` is what proves these two lines still fail. */
// @ts-expect-error sizes without a handler would render a select that does nothing.
const sizesWithoutHandler: PaginationProps = { ...PAGER, pageSizes: [25, 50] };
// @ts-expect-error a handler without sizes would never reach a select.
const handlerWithoutSizes: PaginationProps = {
	...PAGER,
	onPageSizeChange: () => {},
};
void sizesWithoutHandler;
void handlerWithoutSizes;

describe('Pagination', () => {
	it('reads 1 of 1 over an empty set rather than disappearing', async () => {
		const mounted = await mount(
			<Pagination
				pageIndex={0}
				pageSize={25}
				totalRows={0}
				onPageChange={() => {}}
				label="Member pages"
				previousLabel="Previous"
				nextLabel="Next"
				summary={summary}
			/>,
		);
		expect(
			mounted.container.querySelector('.ui-pagination')?.getAttribute(
				'aria-label',
			),
		).toBe('Member pages');
		expect(
			text(mounted.container.querySelector('.ui-pagination__summary')),
		).toBe('1 of 1 · 0-0 of 0');
		expect(
			buttons(mounted.container).map((button) => button.disabled),
		).toEqual([true, true]);
		expect(mounted.container.querySelector('.ui-pagination__size')).toBeNull();
		mounted.unmount();
	});

	it('moves between the pages that exist', async () => {
		const onPageChange = vi.fn();
		const mounted = await mount(
			<Pagination
				pageIndex={1}
				pageSize={25}
				totalRows={120}
				onPageChange={onPageChange}
				label="Member pages"
				previousLabel="Previous"
				nextLabel="Next"
				summary={summary}
			/>,
		);
		expect(
			text(mounted.container.querySelector('.ui-pagination__summary')),
		).toBe('2 of 5 · 26-50 of 120');
		const [previous, next] = buttons(mounted.container);
		expect(previous?.disabled).toBe(false);
		await run(() => next?.click());
		expect(onPageChange).toHaveBeenCalledWith(2);
		mounted.unmount();
	});

	it(
		'offers the page sizes with the pager as the accessible name',
		async () => {
			const onPageSizeChange = vi.fn();
			const mounted = await mount(
				<Pagination
					pageIndex={0}
					pageSize={25}
					totalRows={120}
					pageSizes={[25, 50, 100]}
					onPageSizeChange={onPageSizeChange}
					onPageChange={() => {}}
					label="Member pages"
					previousLabel="Previous"
					nextLabel="Next"
					pageSizeLabel="Members per page"
					summary={summary}
				/>,
			);
			const size = mounted.container.querySelector(
				'.ui-pagination__size',
			) as HTMLSelectElement;
			expect(size.getAttribute('aria-label')).toBe('Members per page');
			expect(Array.from(size.options).map((option) => option.value)).toEqual([
				'25',
				'50',
				'100',
			]);
			expect(size.value).toBe('25');
			await run(() => {
				size.value = '50';
				size.dispatchEvent(new Event('input', { bubbles: true }));
			});
			expect(onPageSizeChange).toHaveBeenCalledWith(50);
			mounted.unmount();
		},
	);
});
