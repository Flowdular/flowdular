import type {
	EvidenceEntry,
	ResearchCaller,
	ResearchResult,
} from './capability.ts';

export { RESEARCH_FRESHNESS } from './capability.ts';

export const RESEARCH_MODULE_ID = 'research.core';

export const RESEARCH_ADAPTERS = [
	'model-native',
	'searxng',
	'firecrawl',
	'connector',
	'recorded',
] as const;
export type ResearchAdapterKey = (typeof RESEARCH_ADAPTERS)[number];

export const RESEARCH_FETCH_ADAPTERS = ['direct', 'firecrawl'] as const;
export type ResearchFetchAdapterKey = (typeof RESEARCH_FETCH_ADAPTERS)[number];

export const RESEARCH_FALLBACK_MODES = ['next-adapter', 'fail'] as const;
export type ResearchFallbackMode = (typeof RESEARCH_FALLBACK_MODES)[number];

export const RESEARCH_ATTEMPT_OUTCOMES = [
	'ok',
	'empty',
	'retryable',
	'permanent',
	'skipped-circuit',
] as const;
export type ResearchAttemptOutcome = (typeof RESEARCH_ATTEMPT_OUTCOMES)[number];

export type ResearchChainAdapterKey =
	| ResearchAdapterKey
	| ResearchFetchAdapterKey;

export const RESEARCH_CHAIN_LIMITS = {
	maxAttemptsMin: 1,
	maxAttemptsMax: 5,
	maxAttemptsDefault: 2,
	timeoutMinMs: 1_000,
	timeoutMaxMs: 60_000,
	timeoutDefaultMs: 15_000,
	backoffMaxMs: 5_000,
	backoffDefaultMs: 500,
	/** Every retry delay, Retry-After included, stops here. */
	backoffCapMs: 5_000,
	thresholdMin: 1,
	thresholdMax: 100,
	thresholdDefault: 5,
	cooldownMinMs: 1_000,
	cooldownMaxMs: 86_400_000,
	cooldownDefaultMs: 300_000,
	attemptsListed: 64,
} as const;

/** The per adapter limits of one chain step. */
export interface ResearchAdapterLimits {
	readonly enabled: boolean;
	readonly maxAttempts: number;
	readonly timeoutMs: number;
}

export const RESEARCH_LIMITS = {
	query: 400,
	searchDefault: 10,
	searchMax: 20,
	site: 253,
	url: 2_048,
	title: 300,
	snippet: 1_000,
	excerptBytes: 4_096,
	callerRef: 200,
	runId: 128,
	ownerModule: 64,
	recordRef: 200,
	attachIds: 64,
	evidenceId: 64,
	listed: 200,
	links: 50,
	/** Characters of page text a caller is handed; the evidence keeps the digest of all of it. */
	fetchText: 200_000,
	memberFetchText: 20_000,
	toolFetchText: 16_000,
	fetchesPerRun: 64,
	pageTtlMs: 24 * 60 * 60 * 1_000,
	robotsTtlMs: 60 * 60 * 1_000,
	robotsBytes: 512 * 1_024,
	robotsTimeoutMs: 5_000,
	robotsHosts: 512,
	fixturesBytes: 1_048_576,
	listDefault: 50,
	listMax: 200,
	budgetMax: 1_000_000,
} as const;

/** The user agent a fetch and a robots.txt read present, and the group it matches. */
export const RESEARCH_USER_AGENT = 'FlowdularResearch/0.1';
export const RESEARCH_ROBOTS_TOKEN = 'flowdularresearch';

/** The meter key metering.core composes from the module id and `queries`. */
export const RESEARCH_QUERIES_METER = 'research.core.queries';

/** Owner module under which result evidence is linked to its query. */
export const RESEARCH_QUERY_LINK_PREFIX = 'query:';

export interface ResearchEvidenceRecord extends EvidenceEntry {
	readonly tenantId: string;
	readonly createdBy: string | null;
	readonly fullText: string | null;
}

export interface ResearchEvidenceLink {
	readonly ownerModule: string;
	readonly recordRef: string;
}

export interface ResearchEvidenceDetail extends EvidenceEntry {
	readonly createdBy: string | null;
	readonly hasFullText: boolean;
	readonly links: readonly ResearchEvidenceLink[];
}

export interface ResearchQueryRecord {
	readonly id: string;
	readonly tenantId: string;
	readonly query: string;
	readonly adapter: ResearchAdapterKey;
	readonly caller: ResearchCaller;
	readonly callerRef: string | null;
	readonly resultCount: number;
	readonly costUnits: number;
	readonly createdAt: number;
}

export interface ResearchPage {
	readonly url: string;
	readonly title: string;
	readonly contentSha256: string;
	readonly text: string;
	readonly fetchedAt: number;
	readonly expiresAt: number;
}

/** Keyset of a list ordered newest first. */
export interface ResearchPosition {
	readonly at: number;
	readonly id: string;
}

export interface ResearchListPage<T> {
	readonly items: readonly T[];
	readonly next: ResearchPosition | null;
}

/** The shape of research-fixtures.json the recorded adapter reads. */
export interface ResearchFixtures {
	readonly queries: Readonly<Record<string, readonly ResearchResult[]>>;
	readonly pages: Readonly<
		Record<string, { readonly title: string; readonly text: string }>
	>;
}

export interface ResearchAttemptRecord {
	readonly tenantId: string;
	readonly id: string;
	readonly queryId: string;
	readonly kind: 'search' | 'fetch';
	readonly adapter: ResearchChainAdapterKey;
	/** 0 for an adapter the circuit breaker skipped. */
	readonly attempt: number;
	readonly outcome: ResearchAttemptOutcome;
	readonly errorCode: string | null;
	readonly durationMs: number;
	readonly createdAt: number;
}

export interface ResearchAdapterHealth {
	readonly adapter: ResearchChainAdapterKey;
	readonly consecutiveFailures: number;
	readonly openUntil: number | null;
	readonly lastErrorCode: string | null;
	readonly lastSuccessAt: number | null;
}

export interface ResearchSettings {
	readonly adapter: ResearchAdapterKey;
	/** Parsed searchOrder; empty keeps the single adapter setting. */
	readonly searchOrder: readonly ResearchAdapterKey[];
	/** Parsed fetchOrder, never empty. */
	readonly fetchOrder: readonly ResearchFetchAdapterKey[];
	readonly fallback: ResearchFallbackMode;
	readonly fallbackOnEmpty: boolean;
	readonly retryBackoffMs: number;
	readonly circuitFailureThreshold: number;
	readonly circuitCooldownMs: number;
	readonly limits: Readonly<
		Record<ResearchChainAdapterKey, ResearchAdapterLimits>
	>;
	readonly connectorInstanceId: string;
	readonly recordedFixturesPath: string;
	readonly allowDomains: readonly string[];
	readonly denyDomains: readonly string[];
	readonly monthlyQueryBudget: number;
	readonly storeFullText: boolean;
	readonly fetchMaxBytes: number;
	readonly fetchTimeoutMs: number;
	readonly allowAgents: boolean;
}

export type ResearchAdapterStatus =
	| 'ready'
	| 'not-configured'
	| 'circuit-open'
	| 'unsupported';

/** What the Search adapters tab shows of one adapter; never a credential. */
export interface ResearchAdapterView {
	readonly key: ResearchChainAdapterKey;
	readonly enabled: boolean;
	readonly maxAttempts: number;
	readonly timeoutMs: number;
	readonly status: ResearchAdapterStatus;
	readonly openUntil: number | null;
	readonly consecutiveFailures: number;
	readonly lastErrorCode: string | null;
	readonly lastSuccessAt: number | null;
	readonly configuration: {
		readonly baseUrl: string | null;
		readonly authKind: string | null;
		readonly hasCredentials: boolean;
		readonly instanceStatus: 'active' | 'disabled' | null;
		readonly connectorInstanceId: string | null;
		readonly recordedFixturesPath: string | null;
	};
}

export interface ResearchReliability {
	readonly fallback: ResearchFallbackMode;
	readonly fallbackOnEmpty: boolean;
	readonly retryBackoffMs: number;
	readonly circuitFailureThreshold: number;
	readonly circuitCooldownMs: number;
}

export interface ResearchAdaptersOverview {
	/** Every search adapter in the order the tab lists it. */
	readonly search: readonly ResearchAdapterView[];
	readonly fetch: readonly ResearchAdapterView[];
	/** True while searchOrder is empty and the single adapter setting decides. */
	readonly legacy: boolean;
	readonly reliability: ResearchReliability;
}

export interface ResearchAdapterTestResult {
	readonly adapter: ResearchAdapterKey;
	readonly outcome: 'ok' | 'empty' | 'failed';
	readonly resultCount: number;
	readonly durationMs: number;
	readonly errorCode: string | null;
	readonly message: string | null;
	readonly attempts: readonly Omit<
		ResearchAttemptRecord,
		'tenantId' | 'id' | 'queryId' | 'kind'
	>[];
}
