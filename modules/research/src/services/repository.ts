import type {
	ResearchAdapterHealth,
	ResearchAdapterKey,
	ResearchAttemptRecord,
	ResearchChainAdapterKey,
	ResearchEvidenceLink,
	ResearchEvidenceRecord,
	ResearchPage,
	ResearchPosition,
	ResearchQueryRecord,
} from '../domain/types.ts';

export interface QueryBudget {
	readonly limit: number;
	/** First instant of the UTC month, epoch milliseconds. */
	readonly since: number;
}

/**
 * Everything research.core stores, each call in its own tenant transaction.
 * Evidence and queries list newest first by (time, id); the exports walk the
 * same keys oldest first.
 */
export interface ResearchRepository {
	/**
	 * Inserts the query row with no results yet, under a per-workspace lock
	 * that reads this month's units first; false when the budget refuses. A
	 * null budget records a search that already happened.
	 */
	reserveQuery(
		record: ResearchQueryRecord,
		runId: string | null,
		budget: QueryBudget | null,
	): Promise<boolean>;
	releaseQuery(tenantId: string, id: string): Promise<void>;
	/**
	 * Sets the result count and the answering adapter when given, and writes
	 * the evidence linked to the query and the chain's attempts, in one
	 * transaction.
	 */
	completeQuery(
		tenantId: string,
		id: string,
		evidence: readonly ResearchEvidenceRecord[],
		adapter?: ResearchAdapterKey,
		attempts?: readonly ResearchAttemptRecord[],
	): Promise<void>;
	monthUsage(tenantId: string, since: number): Promise<number>;
	/** The evidence of the newest model-native query of this run and text, or null without one. */
	nativeEvidence(
		tenantId: string,
		runId: string,
		query: string,
	): Promise<readonly ResearchEvidenceRecord[] | null>;
	/** Counts one fetch of the run unless it already made `limit`; false when refused. */
	takeRunFetch(
		tenantId: string,
		runId: string,
		limit: number,
		now: number,
	): Promise<boolean>;
	findPage(
		tenantId: string,
		url: string,
		now: number,
	): Promise<ResearchPage | null>;
	savePage(tenantId: string, page: ResearchPage): Promise<void>;
	insertEvidence(record: ResearchEvidenceRecord): Promise<void>;
	findEvidence(
		tenantId: string,
		id: string,
	): Promise<ResearchEvidenceRecord | null>;
	evidenceLinks(
		tenantId: string,
		id: string,
		limit: number,
	): Promise<readonly ResearchEvidenceLink[]>;
	/** Writes nothing and answers false unless every id is evidence of the workspace. */
	attach(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
		evidenceIds: readonly string[],
	): Promise<boolean>;
	listAttached(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
		limit: number,
	): Promise<readonly ResearchEvidenceRecord[]>;
	listEvidence(
		tenantId: string,
		limit: number,
		after: ResearchPosition | null,
	): Promise<readonly ResearchEvidenceRecord[]>;
	listQueries(
		tenantId: string,
		limit: number,
		after: ResearchPosition | null,
	): Promise<readonly ResearchQueryRecord[]>;
	sweepEvidence(
		tenantId: string,
		cutoff: number,
		limit: number,
	): Promise<number>;
	exportEvidence(
		tenantId: string,
		after: ResearchPosition | null,
		limit: number,
	): Promise<readonly ResearchEvidenceRecord[]>;
	redactEvidence(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number>;
	countEvidenceOf(tenantId: string, accountId: string): Promise<number>;
	/** Queries and the run counters untouched since the cutoff. */
	sweepQueries(
		tenantId: string,
		cutoff: number,
		limit: number,
	): Promise<number>;
	exportQueries(
		tenantId: string,
		after: ResearchPosition | null,
		limit: number,
	): Promise<readonly ResearchQueryRecord[]>;
	redactQueries(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number>;
	countQueriesOf(tenantId: string, accountId: string): Promise<number>;
	sweepPages(tenantId: string, cutoff: number, limit: number): Promise<number>;
	adapterHealth(tenantId: string): Promise<readonly ResearchAdapterHealth[]>;
	/** Moves an elapsed open time to `until` in one statement; false when another query took the probe. */
	claimAdapterProbe(
		tenantId: string,
		adapter: ResearchChainAdapterKey,
		now: number,
		until: number,
	): Promise<boolean>;
	/** Restores `previous` when the open time is still the probe's `claimedUntil`. */
	releaseAdapterProbe(
		tenantId: string,
		adapter: ResearchChainAdapterKey,
		claimedUntil: number,
		previous: number,
	): Promise<void>;
	/** The newest model-native query of this run and text, or null. */
	nativeQueryId(
		tenantId: string,
		runId: string,
		query: string,
	): Promise<string | null>;
	/** Closes the circuit, resets the count and records the success time. */
	recordAdapterSuccess(
		tenantId: string,
		adapter: ResearchChainAdapterKey,
		now: number,
	): Promise<void>;
	/** Counts one failed query, opening the circuit until `now + cooldownMs` at the threshold. */
	recordAdapterFailure(
		tenantId: string,
		adapter: ResearchChainAdapterKey,
		code: string,
		now: number,
		threshold: number,
		cooldownMs: number,
	): Promise<void>;
	insertAttempts(
		tenantId: string,
		attempts: readonly ResearchAttemptRecord[],
	): Promise<void>;
	/** The attempts of one search or fetch in the order they were made. */
	listAttempts(
		tenantId: string,
		queryId: string,
		limit: number,
	): Promise<readonly ResearchAttemptRecord[]>;
	sweepAttempts(
		tenantId: string,
		cutoff: number,
		limit: number,
	): Promise<number>;
	exportAttempts(
		tenantId: string,
		after: ResearchPosition | null,
		limit: number,
	): Promise<readonly ResearchAttemptRecord[]>;
	/** Removes the attempts of the member's own queries. */
	eraseAttempts(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number>;
	countAttemptsOf(tenantId: string, accountId: string): Promise<number>;
	clearPages(tenantId: string, limit: number): Promise<number>;
	countPages(tenantId: string): Promise<number>;
}
