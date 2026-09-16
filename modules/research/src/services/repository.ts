import type {
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
	/** Sets the result count and writes the evidence linked to the query, in one transaction. */
	completeQuery(
		tenantId: string,
		id: string,
		evidence: readonly ResearchEvidenceRecord[],
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
	clearPages(tenantId: string, limit: number): Promise<number>;
	countPages(tenantId: string): Promise<number>;
}
