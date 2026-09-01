/* Minimal view and widget so the contribution example resolves. A real screen
   follows modules/catalog/src/client/CatalogView.tsrx and the record-screen
   recipe in .ai/skills/ux-design/SKILL.md. */
import { EmptyState, Kpi, PageHeader } from '@coreloom/ui';

export interface CustomerListViewProps {
	readonly csrfToken: string;
}

export function CustomerListView(props: CustomerListViewProps) @{
	void props.csrfToken;
	<div class="ui-view">
		<PageHeader
			eyebrow="Master data"
			title="Customers"
			description="Customer records of the active tenant."
		/>
		<section class="ui-card">
			<EmptyState icon="parties" title="No customers yet">
				Create the first customer.
			</EmptyState>
		</section>
	</div>
}

export function CustomerDashboardWidget() @{
	<Kpi
		label="Customers"
		value="0"
		note="Customer records in this organization."
		href="/customers"
		linkLabel="Open customers"
	/>
}
