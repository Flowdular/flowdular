import type {
	ClientViewContribution,
	WidgetContribution,
} from '../contributions.ts';
import type { ShellView } from '../state.ts';
import { ClientViewOutlet } from './ContributionOutlets.tsrx';
import { DashboardView } from './DashboardView.tsrx';

export interface WorkspaceContentProps {
	activeView: ShellView;
	extensionView: ClientViewContribution | undefined;
	widgets: readonly WidgetContribution[];
	tenantName: string;
	displayName: string;
}

export function WorkspaceContent(props: WorkspaceContentProps) @{
	<div class="workspace__content">
		@if (props.activeView === 'overview') {
			<DashboardView
				widgets={props.widgets}
				tenantName={props.tenantName}
				displayName={props.displayName}
			/>
		}
		@if (props.extensionView) {
			<ClientViewOutlet view={props.extensionView} />
		}
	</div>
}
