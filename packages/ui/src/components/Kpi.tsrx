import type { OctaneNode } from 'octane';

export interface KpiProps {
	label: string;
	value: string;
	unit?: string;
	badge?: OctaneNode;
	note?: OctaneNode;
	href?: string;
	linkLabel?: string;
}

export function Kpi(props: KpiProps) @{
	<article class="ui-kpi">
		<span class="ui-kpi__label">
			{props.label}
			@if (props.badge) {
				<>
					{props.badge}
				</>
			}
		</span>
		<span class="ui-kpi__value">
			{props.value}
			@if (props.unit) {
				<small>{props.unit}</small>
			}
		</span>
		@if (props.note) {
			<span class="ui-kpi__note">{props.note}</span>
		}
		@if (props.href) {
			<a class="ui-kpi__link" href={props.href}>{props.linkLabel ?? 'Open'}</a>
		}
	</article>
}
