import type { DatabaseHandle } from '@flowdular/database';
import { runDatabaseMigrations } from '@flowdular/database';
import { keysetWhere } from '@flowdular/server';
import type { DocumentFilters, DocumentsFile } from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type { DocumentPageCursor, DocumentsRepository } from './repository.ts';

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
	markDeleted: `UPDATE documents_files SET status = 'deleted'
	 WHERE tenant_id = $1 AND id = $2 AND status = 'stored'
	 RETURNING ${COLUMNS}`,
	storedBytes: `SELECT coalesce(sum(bytes), 0) AS bytes FROM documents_files
	 WHERE tenant_id = $1 AND status = 'stored'`,
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

/** A repository over a platform-owned PostgreSQL handle. */
export class DatabaseDocumentsRepository implements DocumentsRepository {
	constructor(private readonly database: DatabaseHandle) {}

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
	): Promise<DocumentsFile | null> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<DocumentsFileRow>({
					text: SQL.markDeleted,
					parameters: [tenantId, id],
				}),
			{ access: 'write', tenantId },
		);
		const row = result.rows[0];
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
}

export async function migrateDocumentsDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'documents.core', databaseMigrations);
}
