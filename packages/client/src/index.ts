export { ApplicationShell } from './ApplicationShell.tsrx';
export {
	createClientContributionRegistry,
	WORKSPACE_SLOTS,
} from './contributions.ts';
export type {
	AccountMenuContribution,
	ClientContributionRegistry,
	ClientViewContribution,
	ModuleClientContext,
	ModuleClientContribution,
	NavigationContribution,
	NavigationGroup,
	WidgetContribution,
	WorkspaceSlot,
} from './contributions.ts';
export {
	createShellState,
	shellLocationFromUrl,
	shellViewFromUrl,
} from './state.ts';
export type { ShellLocation, ShellState, ShellView } from './state.ts';
