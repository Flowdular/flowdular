import type {
	SearchHit,
	SearchPrincipal,
	SearchProvider,
	SearchProviderQuery,
} from '../../src/domain/providers.ts';
import { createSearchProviderRegistry } from '../../src/services/provider-registry.ts';
import type { SearchRepository } from '../../src/services/repository.ts';
import {
	SearchService,
	type SearchBudget,
} from '../../src/services/search-service.ts';

export const TEST_BUDGET: SearchBudget = {
	providerTimeoutMs: 200,
	hitsPerProvider: 20,
};

export function principal(
	scopes: readonly string[],
	accountId = 'account-ada',
	tenantId = 'tenant-a',
): SearchPrincipal {
	return { accountId, tenantId, scopes };
}

export function hit(reference: string, score: number): SearchHit {
	return {
		ref: reference,
		title: reference,
		snippet: 'about ' + reference,
		viewId: 'users',
		route: '/users?member=' + reference,
		score,
	};
}

export interface FakeProviderOptions {
	readonly key: string;
	readonly permission: string;
	readonly label?: string;
	/** One entry per page; the provider cursor is the index of the next one. */
	readonly pages?: readonly (readonly SearchHit[])[];
	/** Rejects instead of answering. */
	readonly fails?: boolean;
	/** Never settles, so only the time budget ends the call. */
	readonly hangs?: boolean;
	/** Answers something the hit reader must refuse. */
	readonly malformed?: boolean;
	readonly onCall?: (input: SearchProviderQuery) => void;
}

/** A provider under the test's control, so no real module has to be composed. */
export function fakeProvider(options: FakeProviderOptions): SearchProvider {
	const pages = options.pages ?? [[]];
	return {
		key: options.key,
		label: options.label ?? options.key,
		permission: options.permission,
		search: async (input) => {
			options.onCall?.(input);
			if (options.fails) throw new Error(`${options.key} is broken`);
			if (options.hangs) return new Promise<never>(() => undefined);
			if (options.malformed) {
				return {
					hits: [{ ...hit('bad', 1), route: 'https://elsewhere.example' }],
					nextCursor: null,
				};
			}
			const index = input.cursor === undefined ? 0 : Number(input.cursor);
			const page = pages[index] ?? [];
			return {
				hits: page.slice(0, input.limit),
				nextCursor: pages[index + 1] ? String(index + 1) : null,
			};
		},
	};
}

export interface HarnessOptions {
	readonly repository: SearchRepository;
	readonly providers?: readonly {
		readonly moduleId: string;
		readonly providers: readonly SearchProvider[];
	}[];
	readonly budget?: SearchBudget;
	readonly now?: () => number;
	/** Leaves registration open, so a case can assert the sealed refusal. */
	readonly unsealed?: boolean;
}

export function createHarness(options: HarnessOptions) {
	const registry = createSearchProviderRegistry();
	for (const entry of options.providers ?? []) {
		registry.register(entry.moduleId, entry.providers);
	}
	if (!options.unsealed) registry.seal();
	return {
		registry,
		service: new SearchService({
			registry,
			repository: options.repository,
			budget: () => options.budget ?? TEST_BUDGET,
			...(options.now ? { now: options.now } : {}),
		}),
	};
}

/** A repository that records nothing, for cases with no database of their own. */
export function nullRepository(): SearchRepository {
	return {
		recordQuery: async () => undefined,
		listRecent: async () => [],
		clearRecent: async () => 0,
		sweepRecent: async () => 0,
		exportRecent: async () => [],
	};
}
