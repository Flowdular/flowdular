import type { OctaneNode } from 'octane';

export interface Fact {
	readonly key: string;
	readonly label: string;
	readonly value: OctaneNode;
}

export interface FactListProps {
	readonly facts: readonly Fact[];
}

/* The read side of a record inside a drawer: label over value, two per row.
   A promotion candidate for @flowdular/ui once a second module needs it. */
export function FactList(props: FactListProps) @{
	<dl class="notifications-facts">
		@for (const fact of props.facts; key fact.key) {
			<div class="notifications-facts__item">
				<dt class="ui-label">{fact.label}</dt>
				<dd>{fact.value}</dd>
			</div>
		}
	</dl>
}
