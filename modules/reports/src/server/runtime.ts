import type { ReportProviderRegistry } from '../domain/providers.ts';
import {
	createReportProviderRegistry,
	type MutableReportProviderRegistry,
} from '../services/provider-registry.ts';
import {
	ReportsService,
	type ReportsBudget,
} from '../services/reports-service.ts';

export interface ReportsRuntimeOptions {
	/** Live platform setting, read again for every request. */
	readonly budget: () => ReportsBudget;
}

export interface ReportsRuntime {
	/** The registration half, registered as `reports.v1` while modules compose. */
	readonly providers: ReportProviderRegistry;
	service(): ReportsService;
	/** Seals the registry: composition is over and nothing may register now. */
	start(): void;
}

/**
 * reports.core owns no rows, so there is no lease, no migration and nothing to
 * dispose: the runtime is the provider registry plus the one service that fans
 * out over it.
 */
export function createReportsRuntime(
	options: ReportsRuntimeOptions,
): ReportsRuntime {
	const registry: MutableReportProviderRegistry =
		createReportProviderRegistry();
	const service = new ReportsService({ registry, budget: options.budget });
	return {
		providers: registry,
		service: () => service,
		start: () => registry.seal(),
	};
}
