import { EmptyState, PageHeader } from '@coreloom/ui';
import type { WidgetContribution } from '../contributions.ts';
import { SlotOutlet, widgetsForSlot } from './ContributionOutlets.tsrx';

export interface DashboardViewProps {
	widgets: readonly WidgetContribution[];
	tenantName: string;
	displayName: string;
}

/* The dashboard is composed from module widgets only: metrics in
   dashboard.metrics, setup steps in dashboard.main, extras in
   dashboard.aside. A disabled module simply contributes nothing. */
export function DashboardView(props: DashboardViewProps) @{
	const metricWidgets = widgetsForSlot(props.widgets, 'dashboard.metrics');
	const mainWidgets = widgetsForSlot(props.widgets, 'dashboard.main');
	const asideWidgets = widgetsForSlot(props.widgets, 'dashboard.aside');
	const firstName =
		props.displayName.split(/\s+/).filter(Boolean)[0] ?? 'there';
	<div class="ui-view">
		<PageHeader
			eyebrow={props.tenantName}
			title={'Welcome, ' + firstName}
			description="Your business platform, built on the Coreloom foundation. Every module you enable adds its records, screens, and agents here."
		/>
		<SlotOutlet className="module-slot--metrics" widgets={metricWidgets} />
		<div class="ui-two-col">
			<section class="ui-card">
				<div class="ui-card__head">
					<span class="ui-card__title">
						Start with the essentials
						<small>
							{mainWidgets.length +
								(mainWidgets.length === 1 ? ' step' : ' steps')}
						</small>
					</span>
				</div>
				<div class="ui-card__body">
					@if (mainWidgets.length === 0) {
						<EmptyState icon="modules" title="No setup steps yet">
							Enabled modules add their first steps here. Enable a module with
							the CLI to see its records, or open Administration to manage users
							and settings.
						</EmptyState>
					} @else {
						<div class="dash-steps">
							@for (const widget of mainWidgets; key widget.id) {
								<div data-contribution-id={widget.id}>{widget.render()}</div>
							}
						</div>
					}
				</div>
			</section>
			<aside class="ui-card">
				<div class="ui-card__head">
					<span class="ui-card__title">
						Active organization
						<small>Scope of everything on this screen</small>
					</span>
				</div>
				<div class="dash-tenant">
					<strong>{props.tenantName}</strong>
					<p>All visible data and actions are scoped to this organization.</p>
					<div class="dash-tenant__row">
						<span>Modules on this dashboard</span>
						<b>{String(props.widgets.length)}</b>
					</div>
				</div>
			</aside>
		</div>
		<SlotOutlet className="module-slot--aside" widgets={asideWidgets} />
	</div>
}
