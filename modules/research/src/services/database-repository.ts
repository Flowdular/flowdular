import type {
	DatabaseHandle,
	DatabaseParameter,
	DatabaseTransaction,
} from '@flowdular/database';
import { runDatabaseMigrations } from '@flowdular/database';
import { keysetWhere } from '@flowdular/server';
import {
	RESEARCH_MODULE_ID,
	RESEARCH_QUERY_LINK_PREFIX,
	type ResearchAdapterKey,
	type ResearchEvidenceLink,
	type ResearchEvidenceRecord,
	type ResearchPage,
	type ResearchPosition,
	type ResearchQueryRecord,
} from '../domain/types.ts';
import type { ResearchCaller } from '../domain/capability.ts';
import { databaseMigrations } from './migration.ts';
import type { QueryBudget, ResearchRepository } from './repository.ts';

type Whole = number | bigint | string;

interface EvidenceRow {
	tenant_id: string;
	id: string;
	url: string;
	title: string;
	excerpt: string;
	content_sha256: string;
	retrieved_at: Whole;
	run_id: string | null;
	document_id: string | null;
	created_by: string | null;
	full_text: string | null;
}

interface QueryRow {
	tenant_id: string;
	id: string;
	query: string;
	adapter: ResearchAdapterKey;
	caller: ResearchCaller;
	caller_ref: string | null;
	result_count: Whole;
	cost_units: Whole;
	created_at: Whole;
}

interface PageRow {
	url: string;
	title: string;
	content_sha256: string;
	text: string;
	fetched_at: Whole;
	expires_at: Whole;
}

const EVIDENCE = `tenant_id, id, url, title, excerpt, content_sha256, retrieved_at,
	 run_id, document_id, created_by, full_text`;
const JOINED_EVIDENCE = EVIDENCE.split(',')
	.map((column) => `evidence.${column.trim()}`)
	.join(', ');
const QUERY = `tenant_id, id, query, adapter, caller, caller_ref, result_count,
	 cost_units, created_at`;

const EVIDENCE_AFTER = keysetWhere(['retrieved_at', 'id'], ['', ''], {
	direction: 'desc',
	parameterOffset: 1,
}).text;
const EVIDENCE_EXPORT_AFTER = keysetWhere(['retrieved_at', 'id'], ['', ''], {
	direction: 'asc',
	parameterOffset: 1,
}).text;
const QUERY_AFTER = keysetWhere(['created_at', 'id'], ['', ''], {
	direction: 'desc',
	parameterOffset: 1,
}).text;
const QUERY_EXPORT_AFTER = keysetWhere(['created_at', 'id'], ['', ''], {
	direction: 'asc',
	parameterOffset: 1,
}).text;

const SQL = {
	lockBudget: `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
	monthUsage: `SELECT COALESCE(SUM(cost_units), 0) AS used FROM research_queries
	 WHERE tenant_id = $1 AND created_at >= $2`,
	insertQuery: `INSERT INTO research_queries (${QUERY})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
	countRunQuery: `INSERT INTO research_run_counters (tenant_id, run_id, fetches, queries, updated_at)
	 VALUES ($1, $2, 0, 1, $3)
	 ON CONFLICT (tenant_id, run_id) DO UPDATE
	 SET queries = research_run_counters.queries + 1, updated_at = EXCLUDED.updated_at`,
	releaseQuery: `DELETE FROM research_queries WHERE tenant_id = $1 AND id = $2`,
	completeQuery: `UPDATE research_queries SET result_count = $3
	 WHERE tenant_id = $1 AND id = $2`,
	insertEvidence: `INSERT INTO research_evidence (${EVIDENCE})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
	insertLinks: `INSERT INTO research_evidence_links (tenant_id, evidence_id, owner_module, record_ref)
	 SELECT $1, linked.value, $3, $4 FROM json_array_elements_text($2::json) AS linked(value)
	 ON CONFLICT DO NOTHING`,
	nativeQuery: `SELECT id FROM research_queries
	 WHERE tenant_id = $1 AND caller_ref = $2 AND adapter = 'model-native' AND query = $3
	 ORDER BY created_at DESC, id DESC LIMIT 1`,
	linkedAscending: `SELECT ${JOINED_EVIDENCE} FROM research_evidence_links AS link
	 JOIN research_evidence AS evidence
	   ON evidence.tenant_id = link.tenant_id AND evidence.id = link.evidence_id
	 WHERE link.tenant_id = $1 AND link.owner_module = $2 AND link.record_ref = $3
	 ORDER BY evidence.retrieved_at, evidence.id LIMIT $4`,
	linkedDescending: `SELECT ${JOINED_EVIDENCE} FROM research_evidence_links AS link
	 JOIN research_evidence AS evidence
	   ON evidence.tenant_id = link.tenant_id AND evidence.id = link.evidence_id
	 WHERE link.tenant_id = $1 AND link.owner_module = $2 AND link.record_ref = $3
	 ORDER BY evidence.retrieved_at DESC, evidence.id DESC LIMIT $4`,
	takeRunFetch: `INSERT INTO research_run_counters (tenant_id, run_id, fetches, queries, updated_at)
	 VALUES ($1, $2, 1, 0, $3)
	 ON CONFLICT (tenant_id, run_id) DO UPDATE
	 SET fetches = research_run_counters.fetches + 1, updated_at = EXCLUDED.updated_at
	 WHERE research_run_counters.fetches < $4
	 RETURNING fetches`,
	findPage: `SELECT url, title, content_sha256, text, fetched_at, expires_at
	 FROM research_pages WHERE tenant_id = $1 AND url = $2 AND expires_at > $3`,
	savePage: `INSERT INTO research_pages (tenant_id, url, title, content_sha256, text, fetched_at, expires_at)
	 VALUES ($1, $2, $3, $4, $5, $6, $7)
	 ON CONFLICT (tenant_id, url) DO UPDATE
	 SET title = EXCLUDED.title, content_sha256 = EXCLUDED.content_sha256,
	     text = EXCLUDED.text, fetched_at = EXCLUDED.fetched_at,
	     expires_at = EXCLUDED.expires_at`,
	findEvidence: `SELECT ${EVIDENCE} FROM research_evidence WHERE tenant_id = $1 AND id = $2`,
	evidenceLinks: `SELECT owner_module, record_ref FROM research_evidence_links
	 WHERE tenant_id = $1 AND evidence_id = $2
	 ORDER BY owner_module, record_ref LIMIT $3`,
	countEvidenceIds: `SELECT COUNT(*) AS found FROM research_evidence
	 WHERE tenant_id = $1 AND id IN (SELECT value FROM json_array_elements_text($2::json))`,
	listEvidence: `SELECT ${EVIDENCE} FROM research_evidence WHERE tenant_id = $1
	 ORDER BY retrieved_at DESC, id DESC LIMIT $2`,
	listEvidenceAfter: `SELECT ${EVIDENCE} FROM research_evidence
	 WHERE tenant_id = $1 AND ${EVIDENCE_AFTER}
	 ORDER BY retrieved_at DESC, id DESC LIMIT $4`,
	exportEvidence: `SELECT ${EVIDENCE} FROM research_evidence WHERE tenant_id = $1
	 ORDER BY retrieved_at, id LIMIT $2`,
	exportEvidenceAfter: `SELECT ${EVIDENCE} FROM research_evidence
	 WHERE tenant_id = $1 AND ${EVIDENCE_EXPORT_AFTER}
	 ORDER BY retrieved_at, id LIMIT $4`,
	listQueries: `SELECT ${QUERY} FROM research_queries WHERE tenant_id = $1
	 ORDER BY created_at DESC, id DESC LIMIT $2`,
	listQueriesAfter: `SELECT ${QUERY} FROM research_queries
	 WHERE tenant_id = $1 AND ${QUERY_AFTER}
	 ORDER BY created_at DESC, id DESC LIMIT $4`,
	exportQueries: `SELECT ${QUERY} FROM research_queries WHERE tenant_id = $1
	 ORDER BY created_at, id LIMIT $2`,
	exportQueriesAfter: `SELECT ${QUERY} FROM research_queries
	 WHERE tenant_id = $1 AND ${QUERY_EXPORT_AFTER}
	 ORDER BY created_at, id LIMIT $4`,
	sweepEvidence: `DELETE FROM research_evidence WHERE tenant_id = $1 AND id IN (
	   SELECT id FROM research_evidence WHERE tenant_id = $1 AND retrieved_at < $2
	   ORDER BY retrieved_at LIMIT $3)`,
	redactEvidence: `UPDATE research_evidence SET created_by = NULL
	 WHERE tenant_id = $1 AND id IN (
	   SELECT id FROM research_evidence WHERE tenant_id = $1 AND created_by = $2 LIMIT $3)`,
	countEvidenceOf: `SELECT COUNT(*) AS found FROM research_evidence
	 WHERE tenant_id = $1 AND created_by = $2`,
	sweepQueries: `DELETE FROM research_queries WHERE tenant_id = $1 AND id IN (
	   SELECT id FROM research_queries WHERE tenant_id = $1 AND created_at < $2
	   ORDER BY created_at LIMIT $3)`,
	sweepRunCounters: `DELETE FROM research_run_counters WHERE tenant_id = $1 AND run_id IN (
	   SELECT run_id FROM research_run_counters WHERE tenant_id = $1 AND updated_at < $2
	   ORDER BY updated_at LIMIT $3)`,
	redactQueries: `UPDATE research_queries SET caller_ref = NULL
	 WHERE tenant_id = $1 AND id IN (
	   SELECT id FROM research_queries
	   WHERE tenant_id = $1 AND caller = 'member' AND caller_ref = $2 LIMIT $3)`,
	countQueriesOf: `SELECT COUNT(*) AS found FROM research_queries
	 WHERE tenant_id = $1 AND caller = 'member' AND caller_ref = $2`,
	sweepPages: `DELETE FROM research_pages WHERE tenant_id = $1 AND url IN (
	   SELECT url FROM research_pages WHERE tenant_id = $1 AND fetched_at < $2
	   ORDER BY fetched_at LIMIT $3)`,
	clearPages: `DELETE FROM research_pages WHERE tenant_id = $1 AND url IN (
	   SELECT url FROM research_pages WHERE tenant_id = $1 LIMIT $2)`,
	countPages: `SELECT COUNT(*) AS found FROM research_pages WHERE tenant_id = $1`,
} as const;

/* PostgreSQL answers BIGINT as a string, so every count and time is read back
   through one check before it reaches the domain. */
function whole(value: Whole, field: string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized) || normalized < 0) {
		throw new Error(`The research database returned an invalid ${field}.`);
	}
	return normalized;
}

function evidenceOf(row: EvidenceRow): ResearchEvidenceRecord {
	return {
		tenantId: row.tenant_id,
		id: row.id,
		url: row.url,
		title: row.title,
		excerpt: row.excerpt,
		contentSha256: row.content_sha256,
		retrievedAt: whole(row.retrieved_at, 'retrieval time'),
		runId: row.run_id,
		documentId: row.document_id,
		createdBy: row.created_by,
		fullText: row.full_text,
	};
}

function queryOf(row: QueryRow): ResearchQueryRecord {
	return {
		tenantId: row.tenant_id,
		id: row.id,
		query: row.query,
		adapter: row.adapter,
		caller: row.caller,
		callerRef: row.caller_ref,
		resultCount: whole(row.result_count, 'result count'),
		costUnits: whole(row.cost_units, 'cost'),
		createdAt: whole(row.created_at, 'creation time'),
	};
}

function evidenceParameters(
	record: ResearchEvidenceRecord,
): DatabaseParameter[] {
	return [
		record.tenantId,
		record.id,
		record.url,
		record.title,
		record.excerpt,
		record.contentSha256,
		record.retrievedAt,
		record.runId,
		record.documentId,
		record.createdBy,
		record.fullText,
	];
}

export class DatabaseResearchRepository implements ResearchRepository {
	constructor(private readonly database: DatabaseHandle) {}

	#read<T>(
		tenantId: string,
		operation: (transaction: DatabaseTransaction) => Promise<T>,
	): Promise<T> {
		return this.database.transaction(operation, { tenantId, access: 'read' });
	}

	#write<T>(
		tenantId: string,
		operation: (transaction: DatabaseTransaction) => Promise<T>,
	): Promise<T> {
		return this.database.transaction(operation, { tenantId, access: 'write' });
	}

	async #count(
		tenantId: string,
		text: string,
		parameters: readonly DatabaseParameter[],
	): Promise<number> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<{ found: Whole }>({
				text,
				parameters: [...parameters],
			}),
		);
		return whole(result.rows[0]?.found ?? 0, 'count');
	}

	async reserveQuery(
		record: ResearchQueryRecord,
		runId: string | null,
		budget: QueryBudget | null,
	): Promise<boolean> {
		return this.#write(record.tenantId, async (transaction) => {
			if (budget !== null) {
				/* Every reservation of one workspace passes this lock, so two
				   searches never both read the last unit as free. */
				await transaction.query({
					text: SQL.lockBudget,
					parameters: [`${RESEARCH_MODULE_ID}.budget:${record.tenantId}`],
				});
				const usage = await transaction.query<{ used: Whole }>({
					text: SQL.monthUsage,
					parameters: [record.tenantId, budget.since],
				});
				const used = whole(usage.rows[0]?.used ?? 0, 'usage');
				if (used + record.costUnits > budget.limit) return false;
			}
			await transaction.execute({
				text: SQL.insertQuery,
				parameters: [
					record.tenantId,
					record.id,
					record.query,
					record.adapter,
					record.caller,
					record.callerRef,
					record.resultCount,
					record.costUnits,
					record.createdAt,
				],
			});
			if (runId !== null) {
				await transaction.execute({
					text: SQL.countRunQuery,
					parameters: [record.tenantId, runId, record.createdAt],
				});
			}
			return true;
		});
	}

	async releaseQuery(tenantId: string, id: string): Promise<void> {
		await this.#write(tenantId, (transaction) =>
			transaction.execute({
				text: SQL.releaseQuery,
				parameters: [tenantId, id],
			}),
		);
	}

	async completeQuery(
		tenantId: string,
		id: string,
		evidence: readonly ResearchEvidenceRecord[],
	): Promise<void> {
		await this.#write(tenantId, async (transaction) => {
			await transaction.execute({
				text: SQL.completeQuery,
				parameters: [tenantId, id, evidence.length],
			});
			for (const record of evidence) {
				await transaction.execute({
					text: SQL.insertEvidence,
					parameters: evidenceParameters(record),
				});
			}
			if (evidence.length > 0) {
				await transaction.execute({
					text: SQL.insertLinks,
					parameters: [
						tenantId,
						JSON.stringify(evidence.map((record) => record.id)),
						RESEARCH_MODULE_ID,
						RESEARCH_QUERY_LINK_PREFIX + id,
					],
				});
			}
		});
	}

	async monthUsage(tenantId: string, since: number): Promise<number> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<{ used: Whole }>({
				text: SQL.monthUsage,
				parameters: [tenantId, since],
			}),
		);
		return whole(result.rows[0]?.used ?? 0, 'usage');
	}

	async nativeEvidence(
		tenantId: string,
		runId: string,
		query: string,
	): Promise<readonly ResearchEvidenceRecord[] | null> {
		return this.#read(tenantId, async (transaction) => {
			const found = await transaction.query<{ id: string }>({
				text: SQL.nativeQuery,
				parameters: [tenantId, runId, query],
			});
			const queryId = found.rows[0]?.id;
			if (queryId === undefined) return null;
			const rows = await transaction.query<EvidenceRow>({
				text: SQL.linkedAscending,
				parameters: [
					tenantId,
					RESEARCH_MODULE_ID,
					RESEARCH_QUERY_LINK_PREFIX + queryId,
					200,
				],
			});
			return rows.rows.map(evidenceOf);
		});
	}

	async takeRunFetch(
		tenantId: string,
		runId: string,
		limit: number,
		now: number,
	): Promise<boolean> {
		const result = await this.#write(tenantId, (transaction) =>
			transaction.query<{ fetches: Whole }>({
				text: SQL.takeRunFetch,
				parameters: [tenantId, runId, now, limit],
			}),
		);
		return result.rows.length === 1;
	}

	async findPage(
		tenantId: string,
		url: string,
		now: number,
	): Promise<ResearchPage | null> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<PageRow>({
				text: SQL.findPage,
				parameters: [tenantId, url, now],
			}),
		);
		const row = result.rows[0];
		return row
			? {
					url: row.url,
					title: row.title,
					contentSha256: row.content_sha256,
					text: row.text,
					fetchedAt: whole(row.fetched_at, 'fetch time'),
					expiresAt: whole(row.expires_at, 'expiry'),
				}
			: null;
	}

	async savePage(tenantId: string, page: ResearchPage): Promise<void> {
		await this.#write(tenantId, (transaction) =>
			transaction.execute({
				text: SQL.savePage,
				parameters: [
					tenantId,
					page.url,
					page.title,
					page.contentSha256,
					page.text,
					page.fetchedAt,
					page.expiresAt,
				],
			}),
		);
	}

	async insertEvidence(record: ResearchEvidenceRecord): Promise<void> {
		await this.#write(record.tenantId, (transaction) =>
			transaction.execute({
				text: SQL.insertEvidence,
				parameters: evidenceParameters(record),
			}),
		);
	}

	async findEvidence(
		tenantId: string,
		id: string,
	): Promise<ResearchEvidenceRecord | null> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<EvidenceRow>({
				text: SQL.findEvidence,
				parameters: [tenantId, id],
			}),
		);
		const row = result.rows[0];
		return row ? evidenceOf(row) : null;
	}

	async evidenceLinks(
		tenantId: string,
		id: string,
		limit: number,
	): Promise<readonly ResearchEvidenceLink[]> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<{ owner_module: string; record_ref: string }>({
				text: SQL.evidenceLinks,
				parameters: [tenantId, id, limit],
			}),
		);
		return result.rows.map((row) => ({
			ownerModule: row.owner_module,
			recordRef: row.record_ref,
		}));
	}

	async attach(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
		evidenceIds: readonly string[],
	): Promise<boolean> {
		return this.#write(tenantId, async (transaction) => {
			const found = await transaction.query<{ found: Whole }>({
				text: SQL.countEvidenceIds,
				parameters: [tenantId, JSON.stringify(evidenceIds)],
			});
			if (whole(found.rows[0]?.found ?? 0, 'count') !== evidenceIds.length) {
				return false;
			}
			await transaction.execute({
				text: SQL.insertLinks,
				parameters: [
					tenantId,
					JSON.stringify(evidenceIds),
					ownerModule,
					recordRef,
				],
			});
			return true;
		});
	}

	async listAttached(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
		limit: number,
	): Promise<readonly ResearchEvidenceRecord[]> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<EvidenceRow>({
				text: SQL.linkedDescending,
				parameters: [tenantId, ownerModule, recordRef, limit],
			}),
		);
		return result.rows.map(evidenceOf);
	}

	async listEvidence(
		tenantId: string,
		limit: number,
		after: ResearchPosition | null,
	): Promise<readonly ResearchEvidenceRecord[]> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<EvidenceRow>(
				after === null
					? { text: SQL.listEvidence, parameters: [tenantId, limit] }
					: {
							text: SQL.listEvidenceAfter,
							parameters: [tenantId, after.at, after.id, limit],
						},
			),
		);
		return result.rows.map(evidenceOf);
	}

	async listQueries(
		tenantId: string,
		limit: number,
		after: ResearchPosition | null,
	): Promise<readonly ResearchQueryRecord[]> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<QueryRow>(
				after === null
					? { text: SQL.listQueries, parameters: [tenantId, limit] }
					: {
							text: SQL.listQueriesAfter,
							parameters: [tenantId, after.at, after.id, limit],
						},
			),
		);
		return result.rows.map(queryOf);
	}

	async sweepEvidence(
		tenantId: string,
		cutoff: number,
		limit: number,
	): Promise<number> {
		const result = await this.#write(tenantId, (transaction) =>
			transaction.execute({
				text: SQL.sweepEvidence,
				parameters: [tenantId, cutoff, limit],
			}),
		);
		return result.affectedRows;
	}

	async exportEvidence(
		tenantId: string,
		after: ResearchPosition | null,
		limit: number,
	): Promise<readonly ResearchEvidenceRecord[]> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<EvidenceRow>(
				after === null
					? { text: SQL.exportEvidence, parameters: [tenantId, limit] }
					: {
							text: SQL.exportEvidenceAfter,
							parameters: [tenantId, after.at, after.id, limit],
						},
			),
		);
		return result.rows.map(evidenceOf);
	}

	async redactEvidence(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number> {
		const result = await this.#write(tenantId, (transaction) =>
			transaction.execute({
				text: SQL.redactEvidence,
				parameters: [tenantId, accountId, limit],
			}),
		);
		return result.affectedRows;
	}

	countEvidenceOf(tenantId: string, accountId: string): Promise<number> {
		return this.#count(tenantId, SQL.countEvidenceOf, [tenantId, accountId]);
	}

	async sweepQueries(
		tenantId: string,
		cutoff: number,
		limit: number,
	): Promise<number> {
		return this.#write(tenantId, async (transaction) => {
			const queries = await transaction.execute({
				text: SQL.sweepQueries,
				parameters: [tenantId, cutoff, limit],
			});
			const counters = await transaction.execute({
				text: SQL.sweepRunCounters,
				parameters: [tenantId, cutoff, limit],
			});
			return queries.affectedRows + counters.affectedRows;
		});
	}

	async exportQueries(
		tenantId: string,
		after: ResearchPosition | null,
		limit: number,
	): Promise<readonly ResearchQueryRecord[]> {
		const result = await this.#read(tenantId, (transaction) =>
			transaction.query<QueryRow>(
				after === null
					? { text: SQL.exportQueries, parameters: [tenantId, limit] }
					: {
							text: SQL.exportQueriesAfter,
							parameters: [tenantId, after.at, after.id, limit],
						},
			),
		);
		return result.rows.map(queryOf);
	}

	async redactQueries(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number> {
		const result = await this.#write(tenantId, (transaction) =>
			transaction.execute({
				text: SQL.redactQueries,
				parameters: [tenantId, accountId, limit],
			}),
		);
		return result.affectedRows;
	}

	countQueriesOf(tenantId: string, accountId: string): Promise<number> {
		return this.#count(tenantId, SQL.countQueriesOf, [tenantId, accountId]);
	}

	async sweepPages(
		tenantId: string,
		cutoff: number,
		limit: number,
	): Promise<number> {
		const result = await this.#write(tenantId, (transaction) =>
			transaction.execute({
				text: SQL.sweepPages,
				parameters: [tenantId, cutoff, limit],
			}),
		);
		return result.affectedRows;
	}

	async clearPages(tenantId: string, limit: number): Promise<number> {
		const result = await this.#write(tenantId, (transaction) =>
			transaction.execute({
				text: SQL.clearPages,
				parameters: [tenantId, limit],
			}),
		);
		return result.affectedRows;
	}

	countPages(tenantId: string): Promise<number> {
		return this.#count(tenantId, SQL.countPages, [tenantId]);
	}
}

export async function migrateResearchDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, RESEARCH_MODULE_ID, databaseMigrations);
}
