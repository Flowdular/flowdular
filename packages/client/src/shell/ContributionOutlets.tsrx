import type {
	ClientViewContribution,
	WidgetContribution,
} from '../contributions.ts';

export function widgetsForSlot(
	widgets: readonly WidgetContribution[],
	slot: WidgetContribution['slot'],
): readonly WidgetContribution[] {
	return widgets.filter((widget) => widget.slot === slot);
}

export function SlotOutlet(props: {
	className: string;
	widgets: readonly WidgetContribution[];
}) @{
	@if (props.widgets.length > 0) {
		<section class={['module-slot', props.className]}>
			@for (const widget of props.widgets; key widget.id) {
				<div
					class="module-slot__item"
					data-contribution-id={widget.id}
				>{widget.render()}</div>
			}
		</section>
	}
}

export function ClientViewOutlet(props: { view: ClientViewContribution }) @{
	<div class="client-view-outlet">{props.view.render()}</div>
}
