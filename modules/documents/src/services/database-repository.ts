import type { DatabaseHandle, DatabaseParameter } from '@flowdular/database';
import { runDatabaseMigrations } from '@flowdular/database';
import { keysetWhere } from '@flowdular/server';
import type { DocumentTextReason, DocumentTextStatus } from '../domain/text.ts';
import type { DocumentFilters, DocumentsFile } from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type {
	ClaimedDocumentText,
	DocumentPageCursor,
	DocumentsRepository,
	DocumentTextRecord,
	DocumentTextRouting,
	SettledDocumentText,
} from './repository.ts';

interface DocumentsFileRow {
	id: string;
	tenant_id: string;
	owner_module: string;
	record_ref: string;
	filename: string;
	content_type: string;
	bytes: number | bigint | string;
	checksum: string | null;
	storage_key: string;
	uploader_account_id: string;
	scan: DocumentsFile['scan'];
	status: DocumentsFile['status'];
	description: string | null;
	created_at: number | bigint | string;
}

interface DocumentTextRow {
	tenant_id: string;
	document_id: string;
	content_sha256: string;
	status: DocumentTextStatus;
	reason: DocumentTextReason | null;
	text: string;
	pages: number | bigint | string;
	truncated: boolean;
	attempts: number | bigint | string;
	requested_at: number | bigint | string;
	extracted_at: number | bigint | string | null;
}

const TEXT_COLUMNS = `tenant_id, document_id, content_sha256, status, reason,
	 text, pages, truncated, attempts, requested_at, extracted_at`;

const COLUMNS = `id, tenant_id, owner_module, record_ref, filename,
	 content_type, bytes, checksum, storage_key, uploader_account_id, scan,
	 status, description, created_at`;

/* A list answers what the workspace still holds plus the infected refusals it
   has to see; a document deleted on purpose leaves the lists and stays in the
   table as the trail. */
const VISIBLE = `(status = 'stored' OR scan = 'infected')`;

/* Queries stay explicit. Values always travel in the adapter's parameter
   channel; nothing from a request is concatenated into SQL. */
const LIST_FILTERS = `tenant_id = $1 AND ${VISIBLE}
	   AND ($2::text IS NULL OR owner_module = $2)
	   AND ($3::text IS NULL OR record_ref = $3)
	   AND ($4::text IS NULL OR scan = $4)
	   AND ($5::text IS NULL OR filename ILIKE $5 OR description ILIKE $5)`;

/* The page order and the keyset predicate are one decision: both columns run
   descending, which is the order documents_files_page_idx carries. */
const PAGE_KEYSET = keysetWhere(['created_at', 'id'], ['', ''], {
	direction: 'desc',
	parameterOffset: 5,
}).text;

const SQL = {
	list: `SELECT ${COLUMNS} FROM documents_files
	 WHERE ${LIST_FILTERS}
	 ORDER BY created_at DESC, id DESC
	 LIMIT $6`,
	listPage: `SELECT ${COLUMNS} FROM documents_files
	 WHERE ${LIST_FILTERS} AND ${PAGE_KEYSET}
	 ORDER BY created_at DESC, id DESC
	 LIMIT $8`,
	/* The row-wise comparison is the keyset of the last row the caller saw, so a
	   long export walks the tenant's slice of the created_at index once instead
	   of paging by offset. */
	listForExport: `SELECT ${COLUMNS} FROM documents_files
	 WHERE tenant_id = $1
	   AND ($2::bigint IS NULL OR (created_at, id) > ($2::bigint, $3::text))
	 ORDER BY created_at, id
	 LIMIT $4`,
	find: `SELECT ${COLUMNS} FROM documents_files
	 WHERE tenant_id = $1 AND id = $2`,
	findAttached: `SELECT ${COLUMNS} FROM documents_files
	 WHERE tenant_id = $1 AND owner_module = $2 AND record_ref = $3 AND id = $4`,
	create: `INSERT INTO documents_files (${COLUMNS})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
	lockStored: `SELECT id FROM documents_files
	 WHERE tenant_id = $1 AND id = $2 AND status = 'stored'
	 FOR UPDATE`,
	markDeleted: `UPDATE documents_files SET status = 'deleted'
	 WHERE tenant_id = $1 AND id = $2 AND status = 'stored'
	 RETURNING ${COLUMNS}`,
	storedBytes: `SELECT coalesce(sum(bytes), 0) AS bytes FROM documents_files
	 WHERE tenant_id = $1 AND status = 'stored'`,
	deleteText: `DELETE FROM documents_text WHERE tenant_id = $1 AND document_id = $2`,
	findText: `SELECT ${TEXT_COLUMNS} FROM documents_text
	 WHERE tenant_id = $1 AND document_id = $2`,
	copyTextByChecksum: `INSERT INTO documents_text (${TEXT_COLUMNS})
	 SELECT tenant_id, $2, content_sha256, status, reason, text, pages, truncated,
	        0, $4, extracted_at
	 FROM documents_text
	 WHERE tenant_id = $1 AND content_sha256 = $3 AND status <> 'pending'
	   AND document_id <> $2
	 LIMIT 1
	 ON CONFLICT (tenant_id, document_id) DO NOTHING
	 RETURNING ${TEXT_COLUMNS}`,
	saveText: `INSERT INTO documents_text (${TEXT_COLUMNS})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::boolean, 0, $9, $9)
	 ON CONFLICT (tenant_id, document_id) DO NOTHING
	 RETURNING ${TEXT_COLUMNS}`,
	enqueueText: `INSERT INTO documents_text (${TEXT_COLUMNS})
	 VALUES ($1, $2, $3, 'pending', NULL, '', 0, false, 0, $4, NULL)
	 ON CONFLICT (tenant_id, document_id) DO NOTHING
	 RETURNING ${TEXT_COLUMNS}`,
	retryText: `UPDATE documents_text
	 SET status = 'pending', reason = NULL, text = '', pages = 0,
	     truncated = false, attempts = 0, requested_at = $3, claimed_by = NULL,
	     claimed_at = NULL, extracted_at = NULL
	 WHERE tenant_id = $1 AND document_id = $2 AND status = 'unscanned'
	 RETURNING ${TEXT_COLUMNS}`,
	/* Read on the background role, which is granted these four columns of
	   pending rows and nothing else. */
	listPendingText: `SELECT tenant_id, document_id, requested_at
	 FROM documents_text
	 WHERE status = 'pending'
	 ORDER BY requested_at, tenant_id, document_id
	 LIMIT $1`,
	/* A claim is a token, so a renewal moving claimed_at never breaks the fence
	   of the settle that follows it, while a takeover replaces the token. */
	claimText: `UPDATE documents_text
	 SET claimed_by = $3, claimed_at = $4, attempts = attempts + 1
	 WHERE tenant_id = $1 AND document_id = $2 AND status = 'pending'
	   AND (claimed_at IS NULL OR claimed_at <= $5)
	 RETURNING tenant_id, document_id, content_sha256, attempts`,
	heartbeatText: `UPDATE documents_text SET claimed_at = $4
	 WHERE tenant_id = $1 AND document_id = $2 AND status = 'pending'
	   AND claimed_by = $3`,
	settleText: `UPDATE documents_text
	 SET status = $4, reason = $5, text = $6, pages = $7, truncated = $8::boolean,
	     extracted_at = $9, claimed_by = NULL, claimed_at = NULL
	 WHERE tenant_id = $1 AND document_id = $2 AND status = 'pending'
	   AND claimed_by = $3`,
	releaseText: `UPDATE documents_text SET claimed_by = NULL, claimed_at = NULL
	 WHERE tenant_id = $1 AND document_id = $2 AND status = 'pending'
	   AND claimed_by = $3`,
	removeClaimedText: `DELETE FROM documents_text
	 WHERE tenant_id = $1 AND document_id = $2 AND status = 'pending'
	   AND claimed_by = $3`,
} as const;

/* PostgreSQL returns BIGINT and a sum as a string, so every numeric read is
   normalized before it reaches the domain. */
function whole(value: number | bigint | string, field: string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized) || normalized < 0) {
		throw new Error(`The documents database returned an invalid ${field}.`);
	}
	return normalized;
}

/* The term is matched as a substring, so the three characters LIKE reads as
   syntax are escaped with the backslash PostgreSQL takes as the default escape
   character; `%` typed by a reader searches for a percent sign. The match runs
   after the tenant predicate, over that workspace's rows alone. */
function likePattern(term: string): string {
	return '%' + term.replace(/[\\%_]/g, (character) => '\\' + character) + '%';
}

function fromRow(row: DocumentsFileRow): DocumentsFile {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		ownerModule: row.owner_module,
		recordRef: row.record_ref,
		filename: row.filename,
		contentType: row.content_type,
		bytes: whole(row.bytes, 'byte count'),
		checksum: row.checksum,
		storageKey: row.storage_key,
		uploaderAccountId: row.uploader_account_id,
		scan: row.scan,
		status: row.status,
		description: row.description,
		createdAt: whole(row.created_at, 'timestamp'),
	};
}

function textFromRow(row: DocumentTextRow): DocumentTextRecord {
	return {
		tenantId: row.tenant_id,
		documentId: row.document_id,
		contentSha256: row.content_sha256,
		status: row.status,
		reason: row.reason,
		text: row.text,
		pages: whole(row.pages, 'page count'),
		truncated: row.truncated,
		attempts: whole(row.attempts, 'attempt count'),
		requestedAt: whole(row.requested_at, 'timestamp'),
		extractedAt:
			row.extracted_at === null ? null : whole(row.extracted_at, 'timestamp'),
	};
}

/**
 * A repository over a platform-owned PostgreSQL handle. The background handle
 * reads the text runner's routing columns across workspaces and nothing else.
 */
export class DatabaseDocumentsRepository implements DocumentsRepository {
	constructor(
		private readonly database: DatabaseHandle,
		private readonly background: DatabaseHandle | null = null,
	) {}

	async list(
		tenantId: string,
		filters: DocumentFilters,
		limit: number,
		after: DocumentPageCursor | null = null,
	): Promise<readonly DocumentsFile[]> {
		const filterParameters = [
			tenantId,
			filters.ownerModule ?? null,
			filters.recordRef ?? null,
			filters.scan ?? null,
			filters.search === undefined ? null : likePattern(filters.search),
		];
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<DocumentsFileRow>({
					text: after === null ? SQL.list : SQL.listPage,
					parameters:
						after === null
							? [...filterParameters, limit]
							: [...filterParameters, after.createdAt, after.id, limit],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromRow);
	}

	async listForExport(
		tenantId: string,
		after: DocumentPageCursor | null,
		limit: number,
	): Promise<readonly DocumentsFile[]> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<DocumentsFileRow>({
					text: SQL.listForExport,
					parameters: [
						tenantId,
						after?.createdAt ?? null,
						after?.id ?? null,
						limit,
					],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromRow);
	}

	async find(tenantId: string, id: string): Promise<DocumentsFile | null> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<DocumentsFileRow>({
					text: SQL.find,
					parameters: [tenantId, id],
				}),
			{ access: 'read', tenantId },
		);
		const row = result.rows[0];
		return row ? fromRow(row) : null;
	}

	async findAttached(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
		id: string,
	): Promise<DocumentsFile | null> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<DocumentsFileRow>({
					text: SQL.findAttached,
					parameters: [tenantId, ownerModule, recordRef, id],
				}),
			{ access: 'read', tenantId },
		);
		const row = result.rows[0];
		return row ? fromRow(row) : null;
	}

	async create(record: DocumentsFile): Promise<DocumentsFile> {
		await this.database.transaction(
			(transaction) =>
				transaction.execute({
					text: SQL.create,
					parameters: [
						record.id,
						record.tenantId,
						record.ownerModule,
						record.recordRef,
						record.filename,
						record.contentType,
						record.bytes,
						record.checksum,
						record.storageKey,
						record.uploaderAccountId,
						record.scan,
						record.status,
						record.description,
						record.createdAt,
					],
				}),
			{ access: 'write', tenantId: record.tenantId },
		);
		return record;
	}

	async markDeleted(
		tenantId: string,
		id: string,
		discard: () => Promise<void>,
	): Promise<DocumentsFile | null> {
		const result = await this.database.transaction(
			async (transaction) => {
				const locked = await transaction.query<{ id: string }>({
					text: SQL.lockStored,
					parameters: [tenantId, id],
				});
				if (locked.rows.length === 0) return null;
				await discard();
				const marked = await transaction.query<DocumentsFileRow>({
					text: SQL.markDeleted,
					parameters: [tenantId, id],
				});
				await transaction.execute({
					text: SQL.deleteText,
					parameters: [tenantId, id],
				});
				return marked;
			},
			{ access: 'write', tenantId },
		);
		const row = result?.rows[0];
		return row ? fromRow(row) : null;
	}

	async storedBytes(tenantId: string): Promise<number> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<{ bytes: number | bigint | string }>({
					text: SQL.storedBytes,
					parameters: [tenantId],
				}),
			{ access: 'read', tenantId },
		);
		return whole(result.rows[0]?.bytes ?? 0, 'byte total');
	}

	async findText(
		tenantId: string,
		documentId: string,
	): Promise<DocumentTextRecord | null> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<DocumentTextRow>({
					text: SQL.findText,
					parameters: [tenantId, documentId],
				}),
			{ access: 'read', tenantId },
		);
		const row = result.rows[0];
		return row ? textFromRow(row) : null;
	}

	async copyTextByChecksum(
		tenantId: string,
		documentId: string,
		contentSha256: string,
		at: number,
	): Promise<DocumentTextRecord | null> {
		const row = await this.#writeText(tenantId, SQL.copyTextByChecksum, [
			tenantId,
			documentId,
			contentSha256,
			at,
		]);
		return row ? textFromRow(row) : null;
	}

	async saveText(
		tenantId: string,
		documentId: string,
		contentSha256: string,
		settled: SettledDocumentText,
		at: number,
	): Promise<DocumentTextRecord> {
		const row = await this.#writeText(tenantId, SQL.saveText, [
			tenantId,
			documentId,
			contentSha256,
			settled.status,
			settled.reason,
			settled.text,
			settled.pages,
			String(settled.truncated),
			at,
		]);
		return this.#kept(tenantId, documentId, row);
	}

	async enqueueText(
		tenantId: string,
		documentId: string,
		contentSha256: string,
		at: number,
	): Promise<DocumentTextRecord> {
		const row = await this.#writeText(tenantId, SQL.enqueueText, [
			tenantId,
			documentId,
			contentSha256,
			at,
		]);
		return this.#kept(tenantId, documentId, row);
	}

	async retryText(
		tenantId: string,
		documentId: string,
		at: number,
	): Promise<DocumentTextRecord | null> {
		const row = await this.#writeText(tenantId, SQL.retryText, [
			tenantId,
			documentId,
			at,
		]);
		return row ? textFromRow(row) : null;
	}

	async listPendingText(
		limit: number,
	): Promise<readonly DocumentTextRouting[]> {
		if (!this.background) {
			throw new Error('The documents text runner needs a background handle.');
		}
		const result = await this.background.query<{
			tenant_id: string;
			document_id: string;
			requested_at: number | bigint | string;
		}>({ text: SQL.listPendingText, parameters: [limit] });
		return result.rows.map((row) => ({
			tenantId: row.tenant_id,
			documentId: row.document_id,
			requestedAt: whole(row.requested_at, 'timestamp'),
		}));
	}

	async claimText(input: {
		readonly tenantId: string;
		readonly documentId: string;
		readonly claimedBy: string;
		readonly claimedAt: number;
		readonly staleBefore: number;
	}): Promise<ClaimedDocumentText | null> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<{
					tenant_id: string;
					document_id: string;
					content_sha256: string;
					attempts: number | bigint | string;
				}>({
					text: SQL.claimText,
					parameters: [
						input.tenantId,
						input.documentId,
						input.claimedBy,
						input.claimedAt,
						input.staleBefore,
					],
				}),
			{ access: 'write', tenantId: input.tenantId },
		);
		const row = result.rows[0];
		return row
			? {
					tenantId: row.tenant_id,
					documentId: row.document_id,
					contentSha256: row.content_sha256,
					attempts: whole(row.attempts, 'attempt count'),
					claimedBy: input.claimedBy,
				}
			: null;
	}

	heartbeatText(
		tenantId: string,
		documentId: string,
		claimedBy: string,
		at: number,
	): Promise<boolean> {
		return this.#fenced(tenantId, SQL.heartbeatText, [
			tenantId,
			documentId,
			claimedBy,
			at,
		]);
	}

	settleText(
		tenantId: string,
		documentId: string,
		claimedBy: string,
		settled: SettledDocumentText,
		at: number,
	): Promise<boolean> {
		return this.#fenced(tenantId, SQL.settleText, [
			tenantId,
			documentId,
			claimedBy,
			settled.status,
			settled.reason,
			settled.text,
			settled.pages,
			String(settled.truncated),
			at,
		]);
	}

	releaseText(
		tenantId: string,
		documentId: string,
		claimedBy: string,
	): Promise<boolean> {
		return this.#fenced(tenantId, SQL.releaseText, [
			tenantId,
			documentId,
			claimedBy,
		]);
	}

	removeClaimedText(
		tenantId: string,
		documentId: string,
		claimedBy: string,
	): Promise<boolean> {
		return this.#fenced(tenantId, SQL.removeClaimedText, [
			tenantId,
			documentId,
			claimedBy,
		]);
	}

	async #writeText(
		tenantId: string,
		text: string,
		parameters: readonly DatabaseParameter[],
	): Promise<DocumentTextRow | null> {
		const result = await this.database.transaction(
			(transaction) => transaction.query<DocumentTextRow>({ text, parameters }),
			{ access: 'write', tenantId },
		);
		return result.rows[0] ?? null;
	}

	/* An insert that lost to a concurrent one answers the row that won. */
	async #kept(
		tenantId: string,
		documentId: string,
		row: DocumentTextRow | null,
	): Promise<DocumentTextRecord> {
		if (row) return textFromRow(row);
		const existing = await this.findText(tenantId, documentId);
		if (!existing) {
			throw new Error('The documents text row vanished while it was written.');
		}
		return existing;
	}

	async #fenced(
		tenantId: string,
		text: string,
		parameters: readonly DatabaseParameter[],
	): Promise<boolean> {
		const result = await this.database.transaction(
			(transaction) => transaction.execute({ text, parameters }),
			{ access: 'write', tenantId },
		);
		return result.affectedRows > 0;
	}
}

export async function migrateDocumentsDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'documents.core', databaseMigrations);
}
