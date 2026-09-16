import { NATIVE_TOOL_UNSUPPORTED } from '@flowdular/harness/runtime';
import type {
	DataClassExportSink,
	DataClassExportSummary,
} from '@flowdular/kernel';
import type { FirecrawlAdapter } from '../adapters/firecrawl.ts';
import type { RecordedAdapter } from '../adapters/recorded.ts';
import type { ResearchAdapter } from '../adapters/types.ts';
import {
	RESEARCH_CALLERS,
	RESEARCH_FRESHNESS,
	type EvidenceEntry,
	type ResearchCaller,
	type ResearchFetchInput,
	type ResearchFetchResult,
	type ResearchFreshness,
	type ResearchResult,
	type ResearchSearchInput,
} from '../domain/capability.ts';
import {
	RESEARCH_CHAIN_LIMITS,
	RESEARCH_LIMITS,
	RESEARCH_MODULE_ID,
	RESEARCH_QUERIES_METER,
	RESEARCH_ROBOTS_TOKEN,
	type ResearchAdapterHealth,
	type ResearchAdapterKey,
	type ResearchAttemptRecord,
	type ResearchEvidenceDetail,
	type ResearchEvidenceRecord,
	type ResearchListPage,
	type ResearchPosition,
	type ResearchQueryRecord,
	type ResearchSettings,
} from '../domain/types.ts';
import type {
	ConnectorEgress,
	DocumentsText,
	EgressCheck,
	MeterRegistry,
} from './capabilities.ts';
import {
	runChain,
	searchChainKeys,
	SYSTEM_CHAIN_RUNTIME,
	type ChainAttempt,
	type ChainHealth,
	type ChainPolicy,
	type ChainRuntime,
	type ChainStep,
} from './adapter-chain.ts';
import { domainAdmitted, siteAdmits } from './domains.ts';
import { htmlToText } from './html-text.ts';
import type { PageResponse, PageTransport } from './page-transport.ts';
import type { ResearchRepository } from './repository.ts';
import {
	boundResults,
	createIdGenerator,
	printable,
	sha256,
	utf8Prefix,
} from './results.ts';
import {
	ADMIT_ALL,
	parseRobots,
	RobotsCache,
	robotsAllows,
	type RobotsRules,
} from './robots.ts';
import { ResearchServiceError } from './service-error.ts';

const DAY_MS = 86_400_000;
const EXPORT_PAGE = 200;
const NATIVE_QUERY_FALLBACK = '(native web search)';
const MODULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const HOST =
	/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const FRESHNESS_MS: Readonly<Record<ResearchFreshness, number>> = {
	day: DAY_MS,
	week: 7 * DAY_MS,
	month: 31 * DAY_MS,
	year: 366 * DAY_MS,
};

function invalid(message: string): ResearchServiceError {
	return new ResearchServiceError('INVALID_INPUT', message);
}

function hasControl(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0)!;
		if (code < 32 || code === 127) return true;
	}
	return false;
}

function line(
	value: unknown,
	field: string,
	minimum: number,
	maximum: number,
): string {
	const normalized = typeof value === 'string' ? value.trim() : '';
	if (normalized.length < minimum || normalized.length > maximum) {
		throw invalid(
			`${field} must contain between ${minimum} and ${maximum} characters.`,
		);
	}
	if (hasControl(normalized)) {
		throw invalid(`${field} contains an unsupported character.`);
	}
	return normalized;
}

function oneOf<T extends string>(
	value: unknown,
	field: string,
	allowed: readonly T[],
): T {
	if (typeof value !== 'string' || !allowed.includes(value as T)) {
		throw invalid(`${field} must be one of ${allowed.join(', ')}.`);
	}
	return value as T;
}

/* PostgreSQL text refuses the NUL character, and a page may carry one. */
function withoutNul(value: string): string {
	return value.split(String.fromCharCode(0)).join('');
}

export function monthStart(at: number): number {
	const date = new Date(at);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

export interface ResearchSearchAnswer {
	readonly results: readonly ResearchResult[];
	readonly adapter: ResearchAdapterKey;
	/** Null for a model-native read back, which counts nothing. */
	readonly queryId: string | null;
	readonly attempts: readonly ChainAttempt[];
}

export interface ResearchSearchOptions {
	/** Runs this one adapter alone and asks it even while its circuit is open. */
	readonly only?: ResearchAdapterKey;
	/** Receives every attempt, also when the search fails. */
	readonly attempts?: ChainAttempt[];
}

export type ResearchAttemptView = Omit<ResearchAttemptRecord, 'tenantId'>;

interface ReadPage {
	readonly title: string;
	readonly text: string;
	readonly redirected: boolean;
}

export interface ResearchEvidenceView extends EvidenceEntry {
	readonly createdBy: string | null;
}

export type ResearchQueryView = Omit<ResearchQueryRecord, 'tenantId'>;

export interface ResearchServiceOptions {
	readonly repository: ResearchRepository;
	/** Live settings of one workspace, read again for every call. */
	readonly settings: (tenantId: string) => Promise<ResearchSettings>;
	readonly adapters: {
		readonly modelNative: ResearchAdapter;
		readonly searxng: ResearchAdapter;
		readonly firecrawl: FirecrawlAdapter;
		readonly connector: ResearchAdapter;
		readonly recorded: RecordedAdapter;
	};
	readonly egress: () => ConnectorEgress | undefined;
	readonly meters: () => MeterRegistry | undefined;
	/** documents.text.v1 when documents.core is composed; a PDF is read through it. */
	readonly documentsText?: (() => DocumentsText | undefined) | undefined;
	readonly transport: PageTransport;
	readonly robots?: RobotsCache;
	readonly now?: () => number;
	/** Timers and the jitter share of retry delays; tests supply their own. */
	readonly chain?: ChainRuntime;
}

export class ResearchService {
	readonly #options: ResearchServiceOptions;
	readonly #repository: ResearchRepository;
	readonly #robots: RobotsCache;
	readonly #now: () => number;
	readonly #id: () => string;
	readonly #chain: ChainRuntime;

	constructor(options: ResearchServiceOptions) {
		this.#options = options;
		this.#repository = options.repository;
		this.#robots =
			options.robots ??
			new RobotsCache(RESEARCH_LIMITS.robotsHosts, RESEARCH_LIMITS.robotsTtlMs);
		this.#now = options.now ?? Date.now;
		this.#id = createIdGenerator(this.#now);
		this.#chain = options.chain ?? { ...SYSTEM_CHAIN_RUNTIME, now: this.#now };
	}

	settings(tenantId: string): Promise<ResearchSettings> {
		return this.#options.settings(line(tenantId, 'tenantId', 1, 128));
	}

	async search(
		input: ResearchSearchInput,
		actor: string | null = null,
		options: ResearchSearchOptions = {},
	): Promise<ResearchSearchAnswer> {
		const tenantId = line(input.tenantId, 'tenantId', 1, 128);
		const query = line(input.query, 'query', 1, RESEARCH_LIMITS.query);
		const limit = input.limit ?? RESEARCH_LIMITS.searchDefault;
		if (
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > RESEARCH_LIMITS.searchMax
		) {
			throw invalid(
				`limit must be an integer between 1 and ${RESEARCH_LIMITS.searchMax}.`,
			);
		}
		const freshness =
			input.freshness === undefined
				? null
				: oneOf(input.freshness, 'freshness', RESEARCH_FRESHNESS);
		const site =
			input.site === undefined || input.site === ''
				? null
				: this.#host(input.site, 'site');
		const { caller, callerRef, runId } = this.#caller(input);
		const settings = await this.#options.settings(tenantId);
		const request = {
			tenantId,
			query,
			limit,
			freshness,
			site,
			caller,
			callerRef,
			settings,
		};
		const createdAt = this.#now();
		const keep = (results: readonly ResearchResult[]) =>
			this.#keep(results, settings, site, freshness, limit, createdAt);
		const id = this.#id();
		const attempts = options.attempts ?? [];
		let reserved = false;
		const release = async () => {
			if (reserved) await this.#repository.releaseQuery(tenantId, id);
			reserved = false;
		};
		const keys =
			options.only === undefined ? searchChainKeys(settings) : [options.only];
		let adapter: ResearchAdapterKey;
		let raw: readonly ResearchResult[];
		try {
			const answer = await runChain<readonly ResearchResult[]>({
				steps: keys.map((key): ChainStep<readonly ResearchResult[]> => {
					const chosen = this.#adapter(key);
					return {
						key,
						maxAttempts: settings.limits[key].maxAttempts,
						timeoutMs: settings.limits[key].timeoutMs,
						breaker: true,
						run: (signal) => chosen.search({ ...request, signal }),
						/* A read back answers evidence already kept, not results to filter. */
						empty: (results) =>
							(key === 'model-native' ? results : keep(results)).length === 0,
					};
				}),
				policy: this.#policy(settings, options.only !== undefined),
				health: this.#health(tenantId, settings),
				attempts,
				signal: input.signal,
				runtime: this.#chain,
				/* One unit per answered query: reserved before the first attempt of
				   an adapter that counts, whatever the chain tries after it. */
				beforeAttempt: async (step) => {
					if (reserved || step.key === 'model-native') return;
					await this.#assertMeter(tenantId);
					reserved = await this.#repository.reserveQuery(
						{
							tenantId,
							id,
							query,
							adapter: step.key as ResearchAdapterKey,
							caller,
							callerRef,
							resultCount: 0,
							costUnits: 1,
							createdAt,
						},
						runId,
						{
							limit: settings.monthlyQueryBudget,
							since: monthStart(createdAt),
						},
					);
					if (!reserved) throw this.#budgetExceeded();
				},
			});
			adapter = answer.adapter as ResearchAdapterKey;
			raw = answer.result;
		} catch (error) {
			await release();
			await this.#saveAttemptsQuietly(tenantId, id, 'search', attempts);
			throw error;
		}
		if (adapter === 'model-native') {
			await release();
			/* A read back creates no query row; its attempts join the native
			   query the run reported, where the Queries tab finds them. */
			const nativeId =
				callerRef === null
					? null
					: await this.#repository.nativeQueryId(tenantId, callerRef, query);
			await this.#saveAttemptsQuietly(
				tenantId,
				nativeId ?? id,
				'search',
				attempts,
			);
			return { results: raw, adapter, queryId: null, attempts };
		}
		let kept: readonly ResearchResult[];
		let evidence: readonly ResearchEvidenceRecord[];
		/* Until the results commit, the unit is only reserved: any failure gives
		   it back, whether the mapping or the write refused. */
		try {
			kept = keep(raw);
			evidence = kept.map((result) =>
				this.#resultEvidence(tenantId, result, createdAt, runId, actor),
			);
			await this.#repository.completeQuery(
				tenantId,
				id,
				evidence,
				adapter,
				this.#attemptRecords(tenantId, id, 'search', attempts),
			);
		} catch (error) {
			await release();
			await this.#saveAttemptsQuietly(tenantId, id, 'search', attempts);
			throw error;
		}
		await this.#recordMeter(tenantId, id, createdAt);
		return {
			results: kept.map((result, index) => ({
				...result,
				evidenceId: evidence[index]!.id,
			})),
			adapter,
			queryId: id,
			attempts,
		};
	}

	/**
	 * Records what a provider's native web search answered inside a run. The
	 * search already happened, so it is counted without asking the budget; the
	 * consent gate asked before the tool was offered.
	 */
	async recordNative(
		tenantId: string,
		runId: string,
		actor: string | null,
		query: string | null,
		results: unknown,
	): Promise<void> {
		const tenant = line(tenantId, 'tenantId', 1, 128);
		const run = line(runId, 'runId', 1, RESEARCH_LIMITS.runId);
		const text =
			query === null || query.trim() === ''
				? NATIVE_QUERY_FALLBACK
				: printable(query).slice(0, RESEARCH_LIMITS.query);
		const settings = await this.#options.settings(tenant);
		const createdAt = this.#now();
		const kept = this.#keep(
			boundResults(results),
			settings,
			null,
			null,
			RESEARCH_LIMITS.searchMax,
			createdAt,
		);
		const id = this.#id();
		await this.#repository.reserveQuery(
			{
				tenantId: tenant,
				id,
				query: text,
				adapter: 'model-native',
				caller: 'agent',
				callerRef: run,
				resultCount: 0,
				costUnits: 1,
				createdAt,
			},
			run,
			null,
		);
		await this.#repository.completeQuery(
			tenant,
			id,
			kept.map((result) =>
				this.#resultEvidence(tenant, result, createdAt, run, actor),
			),
		);
		await this.#recordMeter(tenant, id, createdAt);
		await this.#repository.recordAdapterSuccess(
			tenant,
			'model-native',
			createdAt,
		);
	}

	/**
	 * A provider that cannot pass the native web search on reported so. The
	 * model-native adapter shows as unsupported and its read backs step aside
	 * until a native report with results arrives again.
	 */
	async recordNativeUnsupported(tenantId: string): Promise<void> {
		const tenant = line(tenantId, 'tenantId', 1, 128);
		const settings = await this.#options.settings(tenant);
		await this.#repository.recordAdapterFailure(
			tenant,
			'model-native',
			NATIVE_TOOL_UNSUPPORTED,
			this.#now(),
			settings.circuitFailureThreshold,
			settings.circuitCooldownMs,
		);
	}

	/** Whether agent runs may use the research tools in this workspace now. */
	async agentsAllowed(tenantId: string): Promise<boolean> {
		return (await this.settings(tenantId)).allowAgents;
	}

	/** The consent answer for the native web search, asked when a run starts. */
	async nativeAdmission(
		tenantId: string,
	): Promise<{ readonly granted: boolean; readonly reason?: string }> {
		const settings = await this.settings(tenantId);
		if (!settings.allowAgents) {
			return { granted: false, reason: 'TOOL_NOT_CONSENTED' };
		}
		if (!searchChainKeys(settings).includes('model-native')) {
			return { granted: false, reason: 'RESEARCH_ADAPTER_UNAVAILABLE' };
		}
		const used = await this.#repository.monthUsage(
			tenantId,
			monthStart(this.#now()),
		);
		return used >= settings.monthlyQueryBudget
			? { granted: false, reason: 'RESEARCH_BUDGET_EXCEEDED' }
			: { granted: true };
	}

	async fetch(
		input: ResearchFetchInput,
		actor: string | null = null,
	): Promise<ResearchFetchResult> {
		const tenantId = line(input.tenantId, 'tenantId', 1, 128);
		const url = this.#pageUrl(input.url);
		const { callerRef, runId } = this.#caller(input);
		const settings = await this.#options.settings(tenantId);
		this.#assertDomain(url, settings);
		if (
			runId !== null &&
			!(await this.#repository.takeRunFetch(
				tenantId,
				runId,
				RESEARCH_LIMITS.fetchesPerRun,
				this.#now(),
			))
		) {
			throw new ResearchServiceError(
				'RESEARCH_RUN_LIMIT',
				`A run may fetch at most ${RESEARCH_LIMITS.fetchesPerRun} pages.`,
				429,
			);
		}
		const key = url.toString();
		const evidenceId = this.#id();
		const attempts: ChainAttempt[] = [];
		let title: string;
		let text: string;
		/* A chain with the recorded adapter never reaches the network for a page. */
		if (searchChainKeys(settings).includes('recorded')) {
			const recorded = await this.#options.adapters.recorded.page(
				settings,
				key,
			);
			if (!recorded) {
				throw new ResearchServiceError(
					'RESEARCH_PAGE_NOT_RECORDED',
					'The recorded fixtures hold no page for this URL.',
					404,
				);
			}
			title = recorded.title;
			text = withoutNul(recorded.text);
		} else {
			const cached = await this.#repository.findPage(
				tenantId,
				key,
				this.#now(),
			);
			if (cached) {
				title = cached.title;
				text = cached.text;
			} else {
				let downloaded: ReadPage;
				try {
					downloaded = (
						await runChain<ReadPage>({
							steps: settings.fetchOrder.map((adapter) =>
								adapter === 'direct'
									? this.#directStep(url, settings)
									: this.#firecrawlStep(url, settings, input, callerRef),
							),
							policy: this.#policy(settings, false),
							health: this.#health(tenantId, settings),
							attempts,
							signal: input.signal,
							runtime: this.#chain,
						})
					).result;
				} catch (error) {
					await this.#saveAttemptsQuietly(
						tenantId,
						evidenceId,
						'fetch',
						attempts,
					);
					throw error;
				}
				title = printable(downloaded.title).slice(0, RESEARCH_LIMITS.title);
				text = withoutNul(downloaded.text);
				/* The cache is keyed by the address asked for, so a page another
				   host answered is not kept: a deny rule added for that host must
				   apply to the next fetch. */
				if (!downloaded.redirected) {
					const fetchedAt = this.#now();
					await this.#repository.savePage(tenantId, {
						url: key,
						title,
						contentSha256: sha256(text),
						text,
						fetchedAt,
						expiresAt: fetchedAt + RESEARCH_LIMITS.pageTtlMs,
					});
				}
			}
		}
		const retrievedAt = this.#now();
		const record: ResearchEvidenceRecord = {
			tenantId,
			id: evidenceId,
			url: key,
			title: printable(title).slice(0, RESEARCH_LIMITS.title),
			excerpt: utf8Prefix(text, RESEARCH_LIMITS.excerptBytes),
			contentSha256: sha256(text),
			retrievedAt,
			runId,
			documentId: null,
			createdBy: actor,
			fullText: settings.storeFullText ? text : null,
		};
		await this.#repository.insertEvidence(record);
		await this.#repository.insertAttempts(
			tenantId,
			this.#attemptRecords(tenantId, evidenceId, 'fetch', attempts),
		);
		return {
			evidenceId: record.id,
			title: record.title,
			text: text.slice(0, RESEARCH_LIMITS.fetchText),
			truncated: text.length > RESEARCH_LIMITS.fetchText,
			contentSha256: record.contentSha256,
			retrievedAt,
		};
	}

	async attach(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
		evidenceIds: readonly string[],
	): Promise<void> {
		const tenant = line(tenantId, 'tenantId', 1, 128);
		const owner = this.#owner(ownerModule);
		if (owner === RESEARCH_MODULE_ID) {
			throw invalid(
				'research.core is reserved for the evidence of its own queries.',
			);
		}
		const reference = line(
			recordRef,
			'recordRef',
			1,
			RESEARCH_LIMITS.recordRef,
		);
		if (
			!Array.isArray(evidenceIds) ||
			evidenceIds.length === 0 ||
			evidenceIds.length > RESEARCH_LIMITS.attachIds
		) {
			throw invalid(
				`evidenceIds must name between 1 and ${RESEARCH_LIMITS.attachIds} ids.`,
			);
		}
		const ids = [
			...new Set(
				evidenceIds.map((id) =>
					line(id, 'evidenceId', 1, RESEARCH_LIMITS.evidenceId),
				),
			),
		];
		if (!(await this.#repository.attach(tenant, owner, reference, ids))) {
			throw new ResearchServiceError(
				'RESEARCH_EVIDENCE_NOT_FOUND',
				'Some evidence does not exist in this workspace.',
				404,
			);
		}
	}

	async listAttached(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
	): Promise<EvidenceEntry[]> {
		const records = await this.#repository.listAttached(
			line(tenantId, 'tenantId', 1, 128),
			this.#owner(ownerModule),
			line(recordRef, 'recordRef', 1, RESEARCH_LIMITS.recordRef),
			RESEARCH_LIMITS.listed,
		);
		return records.map((record) => this.#entry(record));
	}

	async getEvidence(
		tenantId: string,
		id: string,
	): Promise<EvidenceEntry | null> {
		if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
			return null;
		}
		const record = await this.#repository.findEvidence(
			line(tenantId, 'tenantId', 1, 128),
			id,
		);
		return record ? this.#entry(record) : null;
	}

	async evidenceDetail(
		tenantId: string,
		id: string,
	): Promise<ResearchEvidenceDetail> {
		const tenant = line(tenantId, 'tenantId', 1, 128);
		const record =
			typeof id === 'string' && id.length > 0 && id.length <= 64
				? await this.#repository.findEvidence(tenant, id)
				: null;
		if (!record) {
			throw new ResearchServiceError(
				'RESEARCH_EVIDENCE_NOT_FOUND',
				'No evidence with this id exists in the workspace.',
				404,
			);
		}
		return {
			...this.#entry(record),
			createdBy: record.createdBy,
			hasFullText: record.fullText !== null,
			links: await this.#repository.evidenceLinks(
				tenant,
				record.id,
				RESEARCH_LIMITS.links,
			),
		};
	}

	async listEvidence(
		tenantId: string,
		limit: number,
		after: ResearchPosition | null,
	): Promise<ResearchListPage<ResearchEvidenceView>> {
		const rows = await this.#repository.listEvidence(
			line(tenantId, 'tenantId', 1, 128),
			limit + 1,
			after,
		);
		const items = rows.slice(0, limit);
		const last = items.at(-1);
		return {
			items: items.map((record) => ({
				...this.#entry(record),
				createdBy: record.createdBy,
			})),
			next:
				rows.length > limit && last
					? { at: last.retrievedAt, id: last.id }
					: null,
		};
	}

	async listQueries(
		tenantId: string,
		limit: number,
		after: ResearchPosition | null,
	): Promise<ResearchListPage<ResearchQueryView>> {
		const rows = await this.#repository.listQueries(
			line(tenantId, 'tenantId', 1, 128),
			limit + 1,
			after,
		);
		const items = rows.slice(0, limit);
		const last = items.at(-1);
		return {
			items: items.map(({ tenantId: _tenant, ...query }) => query),
			next:
				rows.length > limit && last
					? { at: last.createdAt, id: last.id }
					: null,
		};
	}

	async sweepEvidence(tenantId: string, cutoff: Date, limit: number) {
		return {
			removed: await this.#repository.sweepEvidence(
				tenantId,
				cutoff.getTime(),
				limit,
			),
		};
	}

	async exportEvidence(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<DataClassExportSummary> {
		return this.#exportWalk(
			(after) => this.#repository.exportEvidence(tenantId, after, EXPORT_PAGE),
			(record) => record.retrievedAt,
			(record) => ({
				id: record.id,
				url: record.url,
				title: record.title,
				excerpt: record.excerpt,
				contentSha256: record.contentSha256,
				retrievedAt: new Date(record.retrievedAt).toISOString(),
				runId: record.runId,
				documentId: record.documentId,
				createdBy: record.createdBy,
				fullText: record.fullText,
			}),
			sink,
		);
	}

	async eraseEvidence(tenantId: string, accountId: string, limit: number) {
		const redacted = await this.#repository.redactEvidence(
			tenantId,
			accountId,
			limit,
		);
		return { removed: 0, redacted, truncated: redacted >= limit };
	}

	countEvidence(tenantId: string, accountId: string): Promise<number> {
		return this.#repository.countEvidenceOf(tenantId, accountId);
	}

	async sweepQueries(tenantId: string, cutoff: Date, limit: number) {
		return {
			removed: await this.#repository.sweepQueries(
				tenantId,
				cutoff.getTime(),
				limit,
			),
		};
	}

	async exportQueries(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<DataClassExportSummary> {
		return this.#exportWalk(
			(after) => this.#repository.exportQueries(tenantId, after, EXPORT_PAGE),
			(record) => record.createdAt,
			(record) => ({
				id: record.id,
				query: record.query,
				adapter: record.adapter,
				caller: record.caller,
				callerRef: record.callerRef,
				resultCount: record.resultCount,
				costUnits: record.costUnits,
				createdAt: new Date(record.createdAt).toISOString(),
			}),
			sink,
		);
	}

	async eraseQueries(tenantId: string, accountId: string, limit: number) {
		const redacted = await this.#repository.redactQueries(
			tenantId,
			accountId,
			limit,
		);
		return { removed: 0, redacted, truncated: redacted >= limit };
	}

	countQueries(tenantId: string, accountId: string): Promise<number> {
		return this.#repository.countQueriesOf(tenantId, accountId);
	}

	async sweepPages(tenantId: string, cutoff: Date, limit: number) {
		return {
			removed: await this.#repository.sweepPages(
				tenantId,
				cutoff.getTime(),
				limit,
			),
		};
	}

	/* A page names nobody, but its text may name the subject, and it is only a
	   cache: an erasure empties the workspace cache rather than read it. */
	async erasePages(tenantId: string, limit: number) {
		const removed = await this.#repository.clearPages(tenantId, limit);
		return { removed, truncated: removed >= limit };
	}

	countPages(tenantId: string): Promise<number> {
		return this.#repository.countPages(tenantId);
	}

	adapterHealth(tenantId: string): Promise<readonly ResearchAdapterHealth[]> {
		return this.#repository.adapterHealth(line(tenantId, 'tenantId', 1, 128));
	}

	async listAttempts(
		tenantId: string,
		queryId: string,
	): Promise<readonly ResearchAttemptView[]> {
		if (
			typeof queryId !== 'string' ||
			queryId.length === 0 ||
			queryId.length > 64
		) {
			return [];
		}
		const rows = await this.#repository.listAttempts(
			line(tenantId, 'tenantId', 1, 128),
			queryId,
			RESEARCH_CHAIN_LIMITS.attemptsListed,
		);
		return rows.map(({ tenantId: _tenant, ...attempt }) => attempt);
	}

	async sweepAttempts(tenantId: string, cutoff: Date, limit: number) {
		return {
			removed: await this.#repository.sweepAttempts(
				tenantId,
				cutoff.getTime(),
				limit,
			),
		};
	}

	async exportAttempts(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<DataClassExportSummary> {
		return this.#exportWalk(
			(after) => this.#repository.exportAttempts(tenantId, after, EXPORT_PAGE),
			(record) => record.createdAt,
			(record) => ({
				id: record.id,
				queryId: record.queryId,
				kind: record.kind,
				adapter: record.adapter,
				attempt: record.attempt,
				outcome: record.outcome,
				errorCode: record.errorCode,
				durationMs: record.durationMs,
				createdAt: new Date(record.createdAt).toISOString(),
			}),
			sink,
		);
	}

	async eraseAttempts(tenantId: string, accountId: string, limit: number) {
		const removed = await this.#repository.eraseAttempts(
			tenantId,
			accountId,
			limit,
		);
		return { removed, truncated: removed >= limit };
	}

	countAttempts(tenantId: string, accountId: string): Promise<number> {
		return this.#repository.countAttemptsOf(tenantId, accountId);
	}

	#policy(settings: ResearchSettings, ignoreCircuit: boolean): ChainPolicy {
		return {
			fallback: settings.fallback,
			fallbackOnEmpty: settings.fallbackOnEmpty,
			retryBackoffMs: settings.retryBackoffMs,
			circuitFailureThreshold: settings.circuitFailureThreshold,
			circuitCooldownMs: settings.circuitCooldownMs,
			ignoreCircuit,
		};
	}

	#health(tenantId: string, settings: ResearchSettings): ChainHealth {
		const repository = this.#repository;
		return {
			read: () => repository.adapterHealth(tenantId),
			claimProbe: (adapter, now, until) =>
				repository.claimAdapterProbe(tenantId, adapter, now, until),
			succeeded: (adapter, now) =>
				repository.recordAdapterSuccess(tenantId, adapter, now),
			releaseProbe: (adapter, claimedUntil, previous) =>
				repository.releaseAdapterProbe(
					tenantId,
					adapter,
					claimedUntil,
					previous,
				),
			failed: (adapter, code, now) =>
				repository.recordAdapterFailure(
					tenantId,
					adapter,
					code,
					now,
					settings.circuitFailureThreshold,
					settings.circuitCooldownMs,
				),
		};
	}

	#attemptRecords(
		tenantId: string,
		queryId: string,
		kind: 'search' | 'fetch',
		attempts: readonly ChainAttempt[],
	): readonly ResearchAttemptRecord[] {
		return attempts.map((attempt) => ({
			tenantId,
			id: this.#id(),
			queryId,
			kind,
			...attempt,
		}));
	}

	/* A chain that answered nothing already has its own failure to report; a
	   diagnostic write that fails with it must not replace that answer. */
	async #saveAttemptsQuietly(
		tenantId: string,
		queryId: string,
		kind: 'search' | 'fetch',
		attempts: readonly ChainAttempt[],
	): Promise<void> {
		try {
			await this.#repository.insertAttempts(
				tenantId,
				this.#attemptRecords(tenantId, queryId, kind, attempts),
			);
		} catch {
			/* The failure the caller receives is the one that matters. */
		}
	}

	#directStep(url: URL, settings: ResearchSettings): ChainStep<ReadPage> {
		return {
			key: 'direct',
			maxAttempts: settings.limits.direct.maxAttempts,
			/* The reader's own deadline answers RESEARCH_FETCH_TIMEOUT first. */
			timeoutMs: settings.fetchTimeoutMs + 1_000,
			breaker: false,
			run: (signal) => this.#download(url, settings, signal),
			empty: (page) => page.text.trim() === '',
		};
	}

	#firecrawlStep(
		url: URL,
		settings: ResearchSettings,
		input: ResearchFetchInput,
		callerRef: string | null,
	): ChainStep<ReadPage> {
		const limits = settings.limits.firecrawl;
		return {
			key: 'firecrawl',
			maxAttempts: limits.maxAttempts,
			timeoutMs: limits.timeoutMs,
			breaker: true,
			empty: (page) => page.text.trim() === '',
			run: async (signal) => {
				const egress = this.#options.egress();
				if (!egress) throw this.#egressUnavailable();
				await this.#assertRobots(egress, url, signal, signal);
				const page = await this.#options.adapters.firecrawl.page({
					tenantId: input.tenantId,
					url: url.toString(),
					caller: oneOf(input.caller, 'caller', RESEARCH_CALLERS),
					callerRef,
					allowAgents: settings.allowAgents,
					timeoutMs: limits.timeoutMs,
					signal,
				});
				if (page.contentType.toLowerCase().includes('pdf')) {
					throw this.#unsupported(page.contentType);
				}
				let reached: URL;
				try {
					reached = new URL(page.url);
				} catch {
					reached = new URL(url);
				}
				reached.hash = '';
				this.#assertDomain(reached, settings);
				/* Firecrawl followed a redirect: the page it read answers to the
				   robots.txt of the address it ended on too. */
				if (reached.toString() !== url.toString()) {
					await this.#assertRobots(egress, reached, signal, signal);
				}
				if (Buffer.byteLength(page.text, 'utf8') > settings.fetchMaxBytes) {
					throw this.#tooLarge(settings.fetchMaxBytes);
				}
				return {
					title: page.title || url.hostname + url.pathname,
					text: page.text,
					redirected: reached.toString() !== url.toString(),
				};
			},
		};
	}

	async #exportWalk<T extends { readonly id: string }>(
		page: (after: ResearchPosition | null) => Promise<readonly T[]>,
		at: (record: T) => number,
		row: (record: T) => Record<string, unknown>,
		sink: DataClassExportSink,
	): Promise<DataClassExportSummary> {
		let after: ResearchPosition | null = null;
		let rows = 0;
		let from: number | null = null;
		let to: number | null = null;
		for (;;) {
			const records = await page(after);
			for (const record of records) {
				await sink.write(row(record));
				rows += 1;
				const time = at(record);
				if (from === null || time < from) from = time;
				if (to === null || time > to) to = time;
			}
			const last = records.at(-1);
			if (records.length < EXPORT_PAGE || !last) break;
			after = { at: at(last), id: last.id };
		}
		return {
			rows,
			from: from === null ? null : new Date(from),
			to: to === null ? null : new Date(to),
		};
	}

	#entry(record: ResearchEvidenceRecord): EvidenceEntry {
		return {
			id: record.id,
			url: record.url,
			title: record.title,
			excerpt: record.excerpt,
			contentSha256: record.contentSha256,
			retrievedAt: record.retrievedAt,
			runId: record.runId,
			documentId: record.documentId,
		};
	}

	#caller(input: { readonly caller: unknown; readonly callerRef?: unknown }): {
		readonly caller: ResearchCaller;
		readonly callerRef: string | null;
		readonly runId: string | null;
	} {
		const caller = oneOf(input.caller, 'caller', RESEARCH_CALLERS);
		const callerRef =
			input.callerRef === undefined || input.callerRef === ''
				? null
				: line(
						input.callerRef,
						'callerRef',
						1,
						caller === 'member'
							? RESEARCH_LIMITS.callerRef
							: RESEARCH_LIMITS.runId,
					);
		return {
			caller,
			callerRef,
			runId: caller === 'member' ? null : callerRef,
		};
	}

	#host(value: unknown, field: string): string {
		const host = line(value, field, 1, RESEARCH_LIMITS.site)
			.toLowerCase()
			.replace(/^\*?\./, '');
		if (!HOST.test(host)) throw invalid(`${field} must be a host name.`);
		return host;
	}

	#owner(value: unknown): string {
		const owner = line(value, 'ownerModule', 3, RESEARCH_LIMITS.ownerModule);
		if (!MODULE_ID.test(owner)) {
			throw invalid('ownerModule must be a module id.');
		}
		return owner;
	}

	#pageUrl(value: unknown): URL {
		const text = line(value, 'url', 1, RESEARCH_LIMITS.url);
		let url: URL;
		try {
			url = new URL(text);
		} catch {
			throw new ResearchServiceError(
				'RESEARCH_URL_INVALID',
				'url must be an absolute https URL.',
			);
		}
		url.hash = '';
		if (
			url.protocol !== 'https:' ||
			url.username ||
			url.password ||
			url.toString().length > RESEARCH_LIMITS.url
		) {
			throw new ResearchServiceError(
				'RESEARCH_URL_INVALID',
				`url must be an absolute https URL without credentials, at most ${RESEARCH_LIMITS.url} characters once encoded.`,
			);
		}
		return url;
	}

	#assertDomain(url: URL, settings: ResearchSettings): void {
		if (
			!domainAdmitted(url.hostname, settings.allowDomains, settings.denyDomains)
		) {
			throw new ResearchServiceError(
				'RESEARCH_DOMAIN_DENIED',
				`The workspace domain rules refuse ${url.hostname}.`,
				403,
			);
		}
	}

	#adapter(key: ResearchAdapterKey): ResearchAdapter {
		const adapters = this.#options.adapters;
		switch (key) {
			case 'searxng':
				return adapters.searxng;
			case 'firecrawl':
				return adapters.firecrawl;
			case 'connector':
				return adapters.connector;
			case 'recorded':
				return adapters.recorded;
			default:
				return adapters.modelNative;
		}
	}

	#budgetExceeded(): ResearchServiceError {
		return new ResearchServiceError(
			'RESEARCH_BUDGET_EXCEEDED',
			'The monthly research query budget of this workspace is spent.',
			429,
		);
	}

	/* The workspace budget is research.core's own; an operator limit on the
	   meter refuses as well. A metering fault never blocks research, because
	   the budget above it still holds. */
	async #assertMeter(tenantId: string): Promise<void> {
		const meters = this.#options.meters();
		if (!meters) return;
		let verdict: string;
		try {
			verdict = (
				await meters.check({
					tenantId,
					meter: RESEARCH_QUERIES_METER,
					amount: 1,
				})
			).verdict;
		} catch {
			return;
		}
		if (verdict === 'refused') throw this.#budgetExceeded();
	}

	async #recordMeter(tenantId: string, id: string, at: number): Promise<void> {
		const meters = this.#options.meters();
		if (!meters) return;
		try {
			await meters.record({
				tenantId,
				meter: RESEARCH_QUERIES_METER,
				amount: 1,
				at,
				sourceRef: id,
			});
		} catch {
			/* The query row is the record; the meter is a projection of it. */
		}
	}

	#keep(
		results: readonly ResearchResult[],
		settings: ResearchSettings,
		site: string | null,
		freshness: ResearchFreshness | null,
		limit: number,
		now: number,
	): readonly ResearchResult[] {
		const seen = new Set<string>();
		const kept: ResearchResult[] = [];
		for (const result of results) {
			if (kept.length >= limit) break;
			const host = new URL(result.url).hostname;
			if (
				seen.has(result.url) ||
				!domainAdmitted(host, settings.allowDomains, settings.denyDomains) ||
				!siteAdmits(host, site)
			) {
				continue;
			}
			if (freshness !== null && result.publishedAt !== undefined) {
				const published = Date.parse(result.publishedAt);
				if (
					Number.isFinite(published) &&
					published < now - FRESHNESS_MS[freshness]
				) {
					continue;
				}
			}
			seen.add(result.url);
			kept.push({
				url: result.url,
				title: result.title,
				snippet: result.snippet,
				source: result.source,
				...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
			});
		}
		return kept;
	}

	#resultEvidence(
		tenantId: string,
		result: ResearchResult,
		retrievedAt: number,
		runId: string | null,
		actor: string | null,
	): ResearchEvidenceRecord {
		return {
			tenantId,
			id: this.#id(),
			url: result.url,
			title: result.title,
			excerpt: utf8Prefix(result.snippet, RESEARCH_LIMITS.excerptBytes),
			contentSha256: sha256(
				`${result.url}\n${result.title}\n${result.snippet}`,
			),
			retrievedAt,
			runId,
			documentId: null,
			createdBy: actor,
			fullText: null,
		};
	}

	async #download(
		url: URL,
		settings: ResearchSettings,
		signal: AbortSignal,
	): Promise<ReadPage> {
		const egress = this.#options.egress();
		if (!egress) throw this.#egressUnavailable();
		const deadline = AbortSignal.timeout(settings.fetchTimeoutMs);
		const combined = AbortSignal.any([deadline, signal]);
		let target = url;
		for (let hop = 0; ; hop += 1) {
			await this.#assertRobots(egress, target, combined, deadline);
			const response = await this.#get(
				egress,
				target,
				settings.fetchMaxBytes,
				combined,
				deadline,
			);
			if (
				response.status >= 300 &&
				response.status < 400 &&
				response.location !== null
			) {
				if (hop >= 1) {
					throw new ResearchServiceError(
						'RESEARCH_REDIRECT_REFUSED',
						'A fetch follows at most one redirect.',
						502,
					);
				}
				let next: URL;
				try {
					next = new URL(response.location, target);
				} catch {
					throw this.#fetchFailed('The page redirected to an invalid URL.');
				}
				next.hash = '';
				if (next.toString().length > RESEARCH_LIMITS.url) {
					throw this.#fetchFailed(
						'The page redirected to a URL that is too long.',
					);
				}
				this.#assertDomain(next, settings);
				target = next;
				continue;
			}
			if (response.exceeded) throw this.#tooLarge(settings.fetchMaxBytes);
			if (response.status < 200 || response.status > 299) {
				throw this.#fetchFailed(
					`The page answered ${response.status}.`,
					response.status >= 500,
				);
			}
			return {
				...(await this.#extract(response, target, combined, deadline)),
				redirected: hop > 0,
			};
		}
	}

	/* A page failure belongs to the page, never to the adapter's health. */
	#fetchFailed(message: string, retryable = false): ResearchServiceError {
		return new ResearchServiceError('RESEARCH_FETCH_FAILED', message, 502, {
			retryable,
			health: false,
		});
	}

	#timeout(): ResearchServiceError {
		return new ResearchServiceError(
			'RESEARCH_FETCH_TIMEOUT',
			'The page did not answer in time.',
			504,
			{ retryable: true, health: false },
		);
	}

	#tooLarge(maxBytes: number): ResearchServiceError {
		return new ResearchServiceError(
			'RESEARCH_FETCH_TOO_LARGE',
			`The page is larger than ${maxBytes} bytes.`,
			413,
		);
	}

	#egressUnavailable(): ResearchServiceError {
		return new ResearchServiceError(
			'RESEARCH_EGRESS_UNAVAILABLE',
			'connectors.core is not composed, so no page can be fetched.',
			409,
		);
	}

	#unsupported(mediaType: string): ResearchServiceError {
		return new ResearchServiceError(
			'RESEARCH_CONTENT_UNSUPPORTED',
			`Content of type ${mediaType || 'unknown'} cannot be read as text.`,
			415,
		);
	}

	/* A resolution that outlives the fetch deadline answers the timeout; the
	   lookup itself is the policy's to bound. */
	async #check(
		egress: ConnectorEgress,
		url: URL,
		signal: AbortSignal,
		deadline: AbortSignal,
	): Promise<EgressCheck> {
		if (signal.aborted) {
			throw deadline.aborted
				? this.#timeout()
				: this.#fetchFailed('The fetch was cancelled.');
		}
		let release = (): void => undefined;
		const aborted = new Promise<never>((_, reject) => {
			const abort = () =>
				reject(
					deadline.aborted
						? this.#timeout()
						: this.#fetchFailed('The fetch was cancelled.'),
				);
			signal.addEventListener('abort', abort, { once: true });
			release = () => signal.removeEventListener('abort', abort);
		});
		try {
			return await Promise.race([egress.check(url.toString()), aborted]);
		} finally {
			release();
		}
	}

	async #get(
		egress: ConnectorEgress,
		target: URL,
		maxBytes: number,
		signal: AbortSignal,
		deadline: AbortSignal,
	): Promise<PageResponse> {
		const check = await this.#check(egress, target, signal, deadline);
		if (!check.ok) {
			throw new ResearchServiceError(
				'RESEARCH_EGRESS_REFUSED',
				`The egress policy refused the page: ${check.reason}.`,
				403,
			);
		}
		try {
			return await this.#options.transport({
				url: new URL(check.url),
				lookup: check.lookup,
				maxBytes,
				signal,
			});
		} catch {
			if (deadline.aborted) throw this.#timeout();
			throw this.#fetchFailed('The page could not be reached.', true);
		}
	}

	async #assertRobots(
		egress: ConnectorEgress,
		target: URL,
		signal: AbortSignal,
		deadline: AbortSignal,
	): Promise<void> {
		const host = target.host;
		let rules = this.#robots.get(host, this.#now());
		if (rules === null) {
			rules = await this.#readRobots(egress, target, signal, deadline);
			this.#robots.set(host, rules, this.#now());
		}
		if (!robotsAllows(rules, target.pathname + target.search)) {
			throw new ResearchServiceError(
				'RESEARCH_ROBOTS_DISALLOWED',
				`robots.txt of ${target.hostname} disallows this page.`,
				403,
			);
		}
	}

	async #readRobots(
		egress: ConnectorEgress,
		target: URL,
		signal: AbortSignal,
		deadline: AbortSignal,
	): Promise<RobotsRules> {
		const unreadable = () =>
			new ResearchServiceError(
				'RESEARCH_ROBOTS_UNAVAILABLE',
				`robots.txt of ${target.hostname} could not be read.`,
				502,
			);
		const bounded = AbortSignal.any([
			signal,
			AbortSignal.timeout(RESEARCH_LIMITS.robotsTimeoutMs),
		]);
		let location = new URL('/robots.txt', target.origin);
		for (let hop = 0; hop < 2; hop += 1) {
			const check = await this.#check(egress, location, bounded, deadline);
			if (!check.ok) {
				/* The page shares the host of its robots.txt, so the same policy
				   refuses the page as well. */
				if (hop === 0) {
					throw new ResearchServiceError(
						'RESEARCH_EGRESS_REFUSED',
						`The egress policy refused the page: ${check.reason}.`,
						403,
					);
				}
				throw unreadable();
			}
			let response: PageResponse;
			try {
				response = await this.#options.transport({
					url: new URL(check.url),
					lookup: check.lookup,
					maxBytes: RESEARCH_LIMITS.robotsBytes,
					signal: bounded,
				});
			} catch {
				if (deadline.aborted) throw this.#timeout();
				throw unreadable();
			}
			if (
				hop === 0 &&
				response.status >= 300 &&
				response.status < 400 &&
				response.location !== null
			) {
				try {
					location = new URL(response.location, location);
				} catch {
					throw unreadable();
				}
				continue;
			}
			/* Past the cap the rules read so far still apply, as RFC 9309 allows. */
			if (response.status >= 200 && response.status < 300) {
				return parseRobots(
					new TextDecoder('utf-8').decode(response.body),
					RESEARCH_ROBOTS_TOKEN,
				);
			}
			if (response.status >= 400 && response.status < 500) return ADMIT_ALL;
			throw unreadable();
		}
		throw unreadable();
	}

	async #extract(
		response: PageResponse,
		target: URL,
		signal: AbortSignal,
		deadline: AbortSignal,
	): Promise<{ readonly title: string; readonly text: string }> {
		const [type = '', ...parameters] = response.contentType.split(';');
		const mediaType = type.trim().toLowerCase();
		const unsupported = () => this.#unsupported(mediaType);
		if (
			mediaType === 'application/pdf' ||
			response.body.subarray(0, 5).toString('latin1') === '%PDF-'
		) {
			const documents = this.#options.documentsText?.();
			if (!documents) throw unsupported();
			let read: Awaited<ReturnType<typeof documents.extractBytes>>;
			try {
				read = await documents.extractBytes({
					contentType: 'application/pdf',
					bytes: response.body,
					signal,
				});
			} catch (error) {
				/* Reading the text is part of the fetch, so it answers the fetch's
				   own deadline and cancellation. */
				if (deadline.aborted) throw this.#timeout();
				if (signal.aborted) throw this.#fetchFailed('The fetch was cancelled.');
				throw error;
			}
			if (read.status !== 'ok') throw unsupported();
			return {
				title: target.hostname + target.pathname,
				text: read.text.split('\f').join('\n\n').trim(),
			};
		}
		const charset = parameters
			.map((parameter) => parameter.trim())
			.find((parameter) => parameter.toLowerCase().startsWith('charset='))
			?.slice('charset='.length)
			.replace(/"/g, '')
			.trim();
		let decoded: string;
		try {
			decoded = new TextDecoder(charset || 'utf-8').decode(response.body);
		} catch {
			decoded = new TextDecoder('utf-8').decode(response.body);
		}
		if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
			return htmlToText(decoded);
		}
		if (mediaType === 'text/plain') {
			return { title: target.hostname + target.pathname, text: decoded.trim() };
		}
		throw unsupported();
	}
}
