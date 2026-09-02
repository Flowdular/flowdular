import type { OctaneNode } from 'octane';
import type { RowData } from '@octanejs/tanstack-table';
import { Icon } from '../icons/Icon.tsrx';
import { Table, type TableProps } from './Table.tsrx';

export interface TableCardProps<Row extends RowData> extends TableProps<Row> {
	readonly title: string;
	/** The muted count beside the title, e.g. '12 items'. */
	readonly count?: string | undefined;
	/** Head cluster placed before the search and filters slots. */
	readonly head?: OctaneNode;
	readonly search?: OctaneNode;
	readonly filters?: OctaneNode;
	/** Between the head and the table: a toolbar, an inline alert. */
	readonly before?: OctaneNode;
	/** Between the table and the note: pagination. */
	readonly after?: OctaneNode;
	/** The constraint worth stating, rendered as the card's ui-note footer. */
	readonly note?: OctaneNode;
	readonly noteIcon?: string | undefined;
}

/* The default record card: one head with the count, search, and filters on a
   single line, the Table, and the note that states the constraint. */
export function TableCard<Row extends RowData>(props: TableCardProps<Row>) @{
	<section class="ui-card">
		<div class="ui-card__head">
			<span class="ui-card__title">
				{props.title}
				@if (props.count) {
					<small>{props.count}</small>
				}
			</span>
			@if (props.head || props.search || props.filters) {
				<div class="ui-card__actions ui-card__filters">
					{props.head}
					{props.search}
					{props.filters}
				</div>
			}
		</div>
		{props.before}
		<Table {...props} />
		{props.after}
		@if (props.note) {
			<p class="ui-note">
				<Icon name={props.noteIcon ?? 'help'} size={14} />
				<span>{props.note}</span>
			</p>
		}
	</section>
}
