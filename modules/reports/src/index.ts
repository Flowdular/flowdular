import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { REPORTS_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'reports.navigation',
			label: 'Reports',
			href: '/reports',
			order: 70,
			permission: REPORTS_PERMISSIONS.read,
		},
	],
	permissions: Object.values(REPORTS_PERMISSIONS),
} satisfies RegisteredModule;

export { REPORTS_PERMISSIONS } from './acl/permissions.ts';

/* The cross-module contract. A provider module imports the identifier and the
   types from here and resolves the registry through the capability registry;
   nothing else in this module is meant to be imported by another one. */
export {
	REPORTS_PROVIDERS_CAPABILITY,
	REPORT_PROVIDER_LIMITS,
} from './domain/providers.ts';
export type {
	ReportPrincipal,
	ReportProvider,
	ReportProviderAnswer,
	ReportProviderQuery,
	ReportProviderRegistry,
	ReportRange,
	ReportSeries,
	ReportSeriesPoint,
	ReportTile,
} from './domain/providers.ts';

export { REPORT_LIMITS } from './domain/types.ts';
export type {
	ReportProviderSummary,
	WorkspaceReport,
	WorkspaceReportPage,
} from './domain/types.ts';

export { ReportsServiceError } from './services/service-error.ts';
