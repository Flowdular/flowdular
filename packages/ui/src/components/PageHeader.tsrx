import type { OctaneNode } from 'octane';

export interface PageHeaderProps {
	eyebrow?: string;
	title: string;
	description?: string;
	/** Right-aligned actions, typically Button elements. */
	children?: OctaneNode;
}

export function PageHeader(props: PageHeaderProps) @{
	<header class="ui-page-head">
		<div>
			@if (props.eyebrow) {
				<p class="ui-page-head__eyebrow">{props.eyebrow}</p>
			}
			<h1>{props.title}</h1>
			@if (props.description) {
				<p class="ui-page-head__description">{props.description}</p>
			}
		</div>
		@if (props.children) {
			<div class="ui-page-head__actions">{props.children}</div>
		}
	</header>
}
