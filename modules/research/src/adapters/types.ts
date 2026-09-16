import type {
	ResearchCaller,
	ResearchFreshness,
	ResearchResult,
} from '../domain/capability.ts';
import type { ResearchAdapterKey, ResearchSettings } from '../domain/types.ts';

export interface ResearchAdapterSearch {
	readonly tenantId: string;
	readonly query: string;
	readonly limit: number;
	readonly freshness: ResearchFreshness | null;
	readonly site: string | null;
	readonly caller: ResearchCaller;
	readonly callerRef: string | null;
	readonly settings: ResearchSettings;
	readonly signal?: AbortSignal | undefined;
}

export interface ResearchAdapter {
	readonly key: ResearchAdapterKey;
	search(input: ResearchAdapterSearch): Promise<readonly ResearchResult[]>;
}
