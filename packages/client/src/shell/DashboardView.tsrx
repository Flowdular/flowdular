import { EmptyState, PageHeader } from '@flowdular/ui';
import type { WidgetContribution } from '../contributions.ts';
import { t } from '../i18n/runtime.ts';
import { SlotOutlet, widgetsForSlot } from './ContributionOutlets.tsrx';
import { OverviewCharts } from './OverviewCharts.tsrx';

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
		props.displayName.split(/\s+/).filter(Boolean)[0] ??
			t('shell.dashboard.greetingFallback');
	<div class="ui-view">
		<PageHeader
			eyebrow={props.tenantName}
			title={t('shell.dashboard.greeting', { name: firstName })}
			description={t('shell.dashboard.description')}
		/>
		<SlotOutlet className="module-slot--metrics" widgets={metricWidgets} />
		<OverviewCharts />
		<section class="ui-card">
			<div class="ui-card__head">
				<span class="ui-card__title">
					{t('shell.dashboard.steps.title')}
					<small>{t(
						mainWidgets.length === 1
							? 'shell.dashboard.steps.count.one'
							: 'shell.dashboard.steps.count.other',
						{ count: mainWidgets.length },
					)}</small>
				</span>
			</div>
			<div class="ui-card__body">
				@if (mainWidgets.length === 0) {
					<EmptyState
						icon="modules"
						title={t('shell.dashboard.steps.empty.title')}
					>{t('shell.dashboard.steps.empty.hint')}</EmptyState>
				} @else {
					<div class="dash-steps">
						@for (const widget of mainWidgets; key widget.id) {
							<div data-contribution-id={widget.id}>{widget.render()}</div>
						}
					</div>
				}
			</div>
		</section>
		<SlotOutlet className="module-slot--aside" widgets={asideWidgets} />
	</div>
}
