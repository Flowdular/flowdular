import type { OctaneNode } from 'octane';
import { Icon } from '../icons/Icon.tsrx';

export interface FiltersProps {
	readonly open: boolean;
	readonly onToggle: () => void;
	/** Number of filters currently applied; shown as a badge on the button. */
	readonly activeCount?: number;
	readonly label?: string;
	/** The filter controls, rendered inside the dropdown. */
	readonly children?: OctaneNode;
}

/* The default filter surface: a button that opens a dropdown holding the
   controls, so a screen keeps one row in its card head no matter how many
   filters it offers. */
export function Filters(props: FiltersProps) @{
	const count = props.activeCount ?? 0;
	<div class="ui-filters">
		<button
			class={['ui-filters__button', count > 0 && 'ui-filters__button--active']}
			type="button"
			aria-expanded={props.open}
			onClick={props.onToggle}
		>
			<Icon name="filter" size={14} />
			{props.label ?? 'Filters'}
			@if (count > 0) {
				<span class="ui-filters__count">{count}</span>
			}
		</button>
		@if (props.open) {
			<>
				<div class="ui-filters__scrim" onClick={props.onToggle}></div>
				<div class="ui-filters__panel" role="group">{props.children}</div>
			</>
		}
	</div>
}
