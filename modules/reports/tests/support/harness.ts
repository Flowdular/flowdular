import type {
	ReportPrincipal,
	ReportProvider,
	ReportProviderAnswer,
	ReportProviderQuery,
	ReportSeries,
	ReportTile,
} from '../../src/domain/providers.ts';
import { createReportProviderRegistry } from '../../src/services/provider-registry.ts';
import {
	ReportsService,
	type ReportsBudget,
} from '../../src/services/reports-service.ts';

export const TEST_BUDGET: ReportsBudget = { providerTimeoutMs: 200 };

export const TEST_RANGE = { from: '2026-08-14', to: '2026-09-12' } as const;

export function principal(
	scopes: readonly string[],
	accountId = 'account-ada',
	tenantId = 'tenant-a',
): ReportPrincipal {
	return { accountId, tenantId, scopes };
}

export function tile(key: string, value: number): ReportTile {
	return { key, label: key, value, unit: 'units' };
}

export function series(key: string, points: number): ReportSeries {
	return {
		key,
		label: key,
		points: Array.from({ length: points }, (_entry, index) => ({
			at: `2026-08-${String((index % 28) + 1).padStart(2, '0')}`,
			value: index,
		})),
	};
}

export interface FakeProviderOptions {
	readonly key: string;
	readonly permission: string;
	readonly label?: string;
	readonly labelKey?: string;
	readonly answer?: ReportProviderAnswer;
	/** Rejects instead of answering. */
	readonly fails?: boolean;
	/**
	 * Throws on the caller's own stack instead of rejecting, which is what a
	 * provider that validates its input before its first await does.
	 */
	readonly throwsSynchronously?: boolean;
	/** Never settles, so only the time budget ends the call. */
	readonly hangs?: boolean;
	readonly onCall?: (input: ReportProviderQuery) => void;
}

/** A provider under the test's control, so no real module has to be composed. */
export function fakeProvider(options: FakeProviderOptions): ReportProvider {
	return {
		key: options.key,
		label: options.label ?? options.key,
		...(options.labelKey === undefined ? {} : { labelKey: options.labelKey }),
		permission: options.permission,
		read: options.throwsSynchronously
			? (input) => {
					options.onCall?.(input);
					throw new Error(`${options.key} is broken`);
				}
			: async (input) => {
					options.onCall?.(input);
					if (options.fails) throw new Error(`${options.key} is broken`);
					if (options.hangs) return new Promise<never>(() => undefined);
					return options.answer ?? { tiles: [tile(options.key, 1)] };
				},
	};
}

export interface HarnessOptions {
	readonly providers?: readonly {
		readonly moduleId: string;
		readonly providers: readonly ReportProvider[];
	}[];
	readonly budget?: ReportsBudget;
	/** Leaves registration open, so a case can assert the sealed refusal. */
	readonly unsealed?: boolean;
}

export function createHarness(options: HarnessOptions = {}) {
	const registry = createReportProviderRegistry();
	for (const entry of options.providers ?? []) {
		registry.register(entry.moduleId, entry.providers);
	}
	if (!options.unsealed) registry.seal();
	return {
		registry,
		service: new ReportsService({
			registry,
			budget: () => options.budget ?? TEST_BUDGET,
		}),
	};
}
