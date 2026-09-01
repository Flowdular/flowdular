import type { OctaneNode } from 'octane';
import { Icon } from '../icons/Icon.tsrx';

export interface EmptyStateProps {
	icon?: string;
	title: string;
	code?: string;
	children?: OctaneNode;
}

export function EmptyState(props: EmptyStateProps) @{
	<div class="ui-empty">
		@if (props.icon) {
			<span class="ui-empty__icon">
				<Icon name={props.icon ?? 'modules'} size={18} />
			</span>
		}
		<b>{props.title}</b>
		@if (props.children) {
			<p>{props.children}</p>
		}
		@if (props.code) {
			<code>{props.code}</code>
		}
	</div>
}
