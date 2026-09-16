import type { DatabaseHandle, DatabaseParameter } from '@flowdular/database';
import type {
	DocumentRenderStatus,
	DocumentTemplateFormat,
	DocumentTemplateLocale,
	DocumentTemplateOrigin,
} from '../domain/templates.ts';
import type { DocumentsFile } from '../domain/types.ts';

export interface DocumentTemplateRecord {
	readonly tenantId: string;
	readonly key: string;
	readonly ownerModule: string;
	readonly currentVersion: number;
	readonly updatedBy: string;
	readonly updatedAt: number;
}

export interface TemplateVersionSummary {
	readonly version: number;
	readonly origin: DocumentTemplateOrigin;
	readonly contentSha256: string;
	readonly createdBy: string;
	readonly createdAt: number;
}

/** What a version stores; layout and input schema travel as JSON text. */
export interface TemplateVersionContent {
	readonly origin: DocumentTemplateOrigin;
	readonly body: string;
	readonly layout: string;
	readonly inputSchema: string;
	readonly locale: DocumentTemplateLocale;
	readonly format: DocumentTemplateFormat;
	readonly contentSha256: string;
}

export interface TemplateVersionRecord
	extends TemplateVersionSummary,
		TemplateVersionContent {
	readonly tenantId: string;
	readonly key: string;
}

export interface CurrentTemplateVersion {
	readonly template: DocumentTemplateRecord;
	readonly version: TemplateVersionRecord;
}

export interface DocumentRenderRecord {
	readonly id: string;
	readonly tenantId: string;
	readonly templateKey: string;
	readonly version: number;
	readonly ownerModule: string;
	readonly recordRef: string;
	readonly inputDigest: string;
	/** The input as JSON, empty once the render settled. */
	readonly input: string;
	readonly format: DocumentTemplateFormat;
	readonly status: DocumentRenderStatus;
	readonly documentId: string | null;
	readonly errorCode: string | null;
	readonly generation: number;
	readonly attempts: number;
	readonly requestedBy: string;
	readonly createdAt: number;
	readonly finishedAt: number | null;
}

export interface ClaimedRender extends DocumentRenderRecord {
	readonly claimedBy: string;
}

export interface RenderRouting {
	readonly tenantId: string;
	readonly id: string;
	readonly createdAt: number;
}

export type NewRender = Omit<
	DocumentRenderRecord,
	| 'status'
	| 'documentId'
	| 'errorCode'
	| 'generation'
	| 'attempts'
	| 'finishedAt'
>;

/** A caller's idempotency key and the render it first reached. */
export interface RenderKey {
	readonly requestSha256: string;
	readonly renderId: string;
}

export interface DocumentTemplatesRepository {
	listTemplates(
		tenantId: string,
		limit: number,
	): Promise<
		readonly (DocumentTemplateRecord & {
			readonly origin: DocumentTemplateOrigin;
		})[]
	>;
	currentVersion(
		tenantId: string,
		key: string,
	): Promise<CurrentTemplateVersion | null>;
	findVersion(
		tenantId: string,
		key: string,
		version: number,
	): Promise<TemplateVersionRecord | null>;
	/** Newest first, below `before` when given. */
	listVersions(
		tenantId: string,
		key: string,
		limit: number,
		before: number | null,
	): Promise<readonly TemplateVersionSummary[]>;
	/**
	 * Appends versions in order and moves the current version past them, only
	 * while the current version is still `expectedVersion` (0 for a workspace
	 * without a row).
	 */
	appendVersions(input: {
		readonly tenantId: string;
		readonly key: string;
		readonly ownerModule: string;
		readonly expectedVersion: number;
		readonly contents: readonly TemplateVersionContent[];
		readonly actor: string;
		readonly at: number;
	}): Promise<readonly TemplateVersionRecord[] | 'conflict'>;
	/** Inserts a queued render unless its tuple exists, and answers the row kept. */
	createRender(render: NewRender): Promise<{
		readonly render: DocumentRenderRecord;
		readonly created: boolean;
	}>;
	findRender(
		tenantId: string,
		id: string,
	): Promise<DocumentRenderRecord | null>;
	findRenderKey(tenantId: string, key: string): Promise<RenderKey | null>;
	/** Binds a key to a render unless it is bound already, and answers the binding kept. */
	bindRenderKey(input: {
		readonly tenantId: string;
		readonly key: string;
		readonly requestSha256: string;
		readonly renderId: string;
		readonly at: number;
	}): Promise<RenderKey>;
	/** Points a key at the render its request reached when that render already existed. */
	rebindRenderKey(input: {
		readonly tenantId: string;
		readonly key: string;
		readonly from: string;
		readonly to: string;
	}): Promise<boolean>;
	/** Queues a settled render again while it still has the status observed. */
	requeueRender(input: {
		readonly tenantId: string;
		readonly id: string;
		readonly observed: 'failed' | 'succeeded';
		readonly input: string;
		readonly requestedBy: string;
		readonly nextGeneration: boolean;
	}): Promise<DocumentRenderRecord | null>;
	listPendingRenders(
		limit: number,
		staleBefore: number,
	): Promise<readonly RenderRouting[]>;
	claimRender(input: {
		readonly tenantId: string;
		readonly id: string;
		readonly claimedBy: string;
		readonly claimedAt: number;
		readonly staleBefore: number;
	}): Promise<ClaimedRender | null>;
	heartbeatRender(
		tenantId: string,
		id: string,
		claimedBy: string,
		at: number,
	): Promise<boolean>;
	/**
	 * Marks the render succeeded and inserts its document in one transaction,
	 * only while the claim named still holds it; false when it does not.
	 */
	completeRender(input: {
		readonly tenantId: string;
		readonly id: string;
		readonly claimedBy: string;
		readonly document: DocumentsFile;
		readonly at: number;
	}): Promise<boolean>;
	failRender(
		tenantId: string,
		id: string,
		claimedBy: string,
		errorCode: string,
		at: number,
	): Promise<boolean>;
	releaseRender(
		tenantId: string,
		id: string,
		claimedBy: string,
	): Promise<boolean>;
	sweepRenders(
		tenantId: string,
		cutoff: number,
		limit: number,
	): Promise<number>;
	exportVersions(
		tenantId: string,
		after: { readonly key: string; readonly version: number } | null,
		limit: number,
	): Promise<readonly TemplateVersionRecord[]>;
	exportRenders(
		tenantId: string,
		after: { readonly createdAt: number; readonly id: string } | null,
		limit: number,
	): Promise<readonly DocumentRenderRecord[]>;
}

type Numeric = number | bigint | string;

interface VersionRow {
	tenant_id: string;
	template_key: string;
	version: Numeric;
	origin: DocumentTemplateOrigin;
	body: string;
	layout: string;
	input_schema: string;
	locale: DocumentTemplateLocale;
	format: DocumentTemplateFormat;
	content_sha256: string;
	created_by: string;
	created_at: Numeric;
}

interface TemplateRow {
	tenant_id: string;
	template_key: string;
	owner_module: string;
	current_version: Numeric;
	updated_by: string;
	updated_at: Numeric;
}

interface RenderRow {
	id: string;
	tenant_id: string;
	template_key: string;
	version: Numeric;
	owner_module: string;
	record_ref: string;
	input_digest: string;
	input: string;
	format: DocumentTemplateFormat;
	status: DocumentRenderStatus;
	document_id: string | null;
	error_code: string | null;
	generation: Numeric;
	attempts: Numeric;
	requested_by: string;
	claimed_by: string | null;
	created_at: Numeric;
	finished_at: Numeric | null;
}

const VERSION_COLUMNS = `tenant_id, template_key, version, origin, body, layout,
	 input_schema, locale, format, content_sha256, created_by, created_at`;

const TEMPLATE_COLUMNS = `tenant_id, template_key, owner_module, current_version,
	 updated_by, updated_at`;

const RENDER_COLUMNS = `id, tenant_id, template_key, version, owner_module,
	 record_ref, input_digest, input, format, status, document_id, error_code,
	 generation, attempts, requested_by, claimed_by, created_at, finished_at`;

const FILE_COLUMNS = `id, tenant_id, owner_module, record_ref, filename,
	 content_type, bytes, checksum, storage_key, uploader_account_id, scan,
	 status, description, created_at`;

const SQL = {
	listTemplates: `SELECT t.tenant_id, t.template_key, t.owner_module, t.current_version,
	        t.updated_by, t.updated_at, v.origin
	 FROM document_templates AS t
	 JOIN document_template_versions AS v
	   ON v.tenant_id = t.tenant_id AND v.template_key = t.template_key
	  AND v.version = t.current_version
	 WHERE t.tenant_id = $1
	 ORDER BY t.template_key
	 LIMIT $2`,
	findTemplate: `SELECT ${TEMPLATE_COLUMNS} FROM document_templates
	 WHERE tenant_id = $1 AND template_key = $2`,
	lockTemplate: `SELECT current_version FROM document_templates
	 WHERE tenant_id = $1 AND template_key = $2
	 FOR UPDATE`,
	insertTemplate: `INSERT INTO document_templates (${TEMPLATE_COLUMNS})
	 VALUES ($1, $2, $3, $4, $5, $6)
	 ON CONFLICT (tenant_id, template_key) DO NOTHING`,
	advanceTemplate: `UPDATE document_templates
	 SET current_version = $4, updated_by = $5, updated_at = $6
	 WHERE tenant_id = $1 AND template_key = $2 AND current_version = $3`,
	insertVersion: `INSERT INTO document_template_versions (${VERSION_COLUMNS})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
	 RETURNING ${VERSION_COLUMNS}`,
	findVersion: `SELECT ${VERSION_COLUMNS} FROM document_template_versions
	 WHERE tenant_id = $1 AND template_key = $2 AND version = $3`,
	listVersions: `SELECT version, origin, content_sha256, created_by, created_at
	 FROM document_template_versions
	 WHERE tenant_id = $1 AND template_key = $2
	   AND ($3::integer IS NULL OR version < $3::integer)
	 ORDER BY version DESC
	 LIMIT $4`,
	exportVersions: `SELECT ${VERSION_COLUMNS} FROM document_template_versions
	 WHERE tenant_id = $1
	   AND ($2::text IS NULL OR (template_key, version) > ($2::text, $3::integer))
	 ORDER BY template_key, version
	 LIMIT $4`,
	createRender: `INSERT INTO document_renders
	 (id, tenant_id, template_key, version, owner_module, record_ref, input_digest,
	  input, format, status, requested_by, created_at)
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $11)
	 ON CONFLICT (tenant_id, template_key, version, owner_module, record_ref, format, input_digest) DO NOTHING
	 RETURNING ${RENDER_COLUMNS}`,
	findRenderByTuple: `SELECT ${RENDER_COLUMNS} FROM document_renders
	 WHERE tenant_id = $1 AND template_key = $2 AND version = $3
	   AND owner_module = $4 AND record_ref = $5 AND format = $6 AND input_digest = $7`,
	findRender: `SELECT ${RENDER_COLUMNS} FROM document_renders
	 WHERE tenant_id = $1 AND id = $2`,
	requeueRender: `UPDATE document_renders
	 SET status = 'queued', input = $4, requested_by = $5, error_code = NULL,
	     attempts = 0, claimed_by = NULL, claimed_at = NULL, finished_at = NULL,
	     generation = generation + $6,
	     document_id = CASE WHEN $6 > 0 THEN NULL ELSE document_id END
	 WHERE tenant_id = $1 AND id = $2 AND status = $3
	 RETURNING ${RENDER_COLUMNS}`,
	/* Read on the background role, which is granted these columns of queued and
	   running renders and nothing else. */
	listPendingRenders: `SELECT id, tenant_id, created_at FROM document_renders
	 WHERE status IN ('queued', 'running')
	   AND (claimed_at IS NULL OR claimed_at <= $2)
	 ORDER BY created_at, tenant_id, id
	 LIMIT $1`,
	/* A claim is a token, so a renewal moving claimed_at never breaks the fence
	   of the settle that follows it, while a takeover replaces the token. */
	claimRender: `UPDATE document_renders
	 SET status = 'running', claimed_by = $3, claimed_at = $4, attempts = attempts + 1
	 WHERE tenant_id = $1 AND id = $2
	   AND (status = 'queued' OR (status = 'running' AND claimed_at <= $5))
	 RETURNING ${RENDER_COLUMNS}`,
	heartbeatRender: `UPDATE document_renders SET claimed_at = $4
	 WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND claimed_by = $3`,
	completeRender: `UPDATE document_renders
	 SET status = 'succeeded', document_id = $4, input = '', error_code = NULL,
	     claimed_by = NULL, claimed_at = NULL, finished_at = $5
	 WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND claimed_by = $3`,
	insertDocument: `INSERT INTO documents_files (${FILE_COLUMNS})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
	 ON CONFLICT DO NOTHING`,
	failRender: `UPDATE document_renders
	 SET status = 'failed', error_code = $4, input = '', claimed_by = NULL,
	     claimed_at = NULL, finished_at = $5
	 WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND claimed_by = $3`,
	releaseRender: `UPDATE document_renders
	 SET status = 'queued', claimed_by = NULL, claimed_at = NULL
	 WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND claimed_by = $3`,
	findRenderKey: `SELECT request_sha256, render_id FROM document_render_keys
	 WHERE tenant_id = $1 AND idempotency_key = $2`,
	bindRenderKey: `INSERT INTO document_render_keys
	 (tenant_id, idempotency_key, request_sha256, render_id, created_at)
	 VALUES ($1, $2, $3, $4, $5)
	 ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
	 RETURNING request_sha256, render_id`,
	rebindRenderKey: `UPDATE document_render_keys SET render_id = $4
	 WHERE tenant_id = $1 AND idempotency_key = $2 AND render_id = $3`,
	/* The keys go with the renders they name; both statements pick the same
	   oldest settled renders inside one transaction. */
	sweepRenderKeys: `DELETE FROM document_render_keys
	 WHERE tenant_id = $1 AND render_id IN (
	   SELECT id FROM document_renders
	   WHERE tenant_id = $1 AND status IN ('succeeded', 'failed') AND created_at < $2
	   ORDER BY created_at, id
	   LIMIT $3
	 )`,
	/* A key bound to a render that was never written names nothing; it goes
	   once it is as old as the renders swept with it. */
	sweepLostRenderKeys: `DELETE FROM document_render_keys
	 WHERE tenant_id = $1 AND idempotency_key IN (
	   SELECT keys.idempotency_key FROM document_render_keys AS keys
	   WHERE keys.tenant_id = $1 AND keys.created_at < $2
	     AND NOT EXISTS (
	       SELECT 1 FROM document_renders AS renders
	       WHERE renders.tenant_id = $1 AND renders.id = keys.render_id
	     )
	   ORDER BY keys.created_at, keys.idempotency_key
	   LIMIT $3
	 )`,
	sweepRenders: `DELETE FROM document_renders
	 WHERE tenant_id = $1 AND id IN (
	   SELECT id FROM document_renders
	   WHERE tenant_id = $1 AND status IN ('succeeded', 'failed') AND created_at < $2
	   ORDER BY created_at, id
	   LIMIT $3
	 )`,
	exportRenders: `SELECT ${RENDER_COLUMNS} FROM document_renders
	 WHERE tenant_id = $1
	   AND ($2::bigint IS NULL OR (created_at, id) > ($2::bigint, $3::text))
	 ORDER BY created_at, id
	 LIMIT $4`,
} as const;

function whole(value: Numeric, field: string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized) || normalized < 0) {
		throw new Error(`The documents database returned an invalid ${field}.`);
	}
	return normalized;
}

function versionFromRow(row: VersionRow): TemplateVersionRecord {
	return {
		tenantId: row.tenant_id,
		key: row.template_key,
		version: whole(row.version, 'version'),
		origin: row.origin,
		body: row.body,
		layout: row.layout,
		inputSchema: row.input_schema,
		locale: row.locale,
		format: row.format,
		contentSha256: row.content_sha256,
		createdBy: row.created_by,
		createdAt: whole(row.created_at, 'timestamp'),
	};
}

function templateFromRow(row: TemplateRow): DocumentTemplateRecord {
	return {
		tenantId: row.tenant_id,
		key: row.template_key,
		ownerModule: row.owner_module,
		currentVersion: whole(row.current_version, 'version'),
		updatedBy: row.updated_by,
		updatedAt: whole(row.updated_at, 'timestamp'),
	};
}

function renderFromRow(row: RenderRow): DocumentRenderRecord {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		templateKey: row.template_key,
		version: whole(row.version, 'version'),
		ownerModule: row.owner_module,
		recordRef: row.record_ref,
		inputDigest: row.input_digest,
		input: row.input,
		format: row.format,
		status: row.status,
		documentId: row.document_id,
		errorCode: row.error_code,
		generation: whole(row.generation, 'generation'),
		attempts: whole(row.attempts, 'attempt count'),
		requestedBy: row.requested_by,
		createdAt: whole(row.created_at, 'timestamp'),
		finishedAt:
			row.finished_at === null ? null : whole(row.finished_at, 'timestamp'),
	};
}

/**
 * Template versions and renders over a platform-owned PostgreSQL handle. The
 * background handle reads the render runner's routing columns and nothing else.
 */
export class DatabaseTemplatesRepository
	implements DocumentTemplatesRepository
{
	constructor(
		private readonly database: DatabaseHandle,
		private readonly background: DatabaseHandle | null = null,
	) {}

	async listTemplates(tenantId: string, limit: number) {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<TemplateRow & { origin: DocumentTemplateOrigin }>({
					text: SQL.listTemplates,
					parameters: [tenantId, limit],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map((row) => ({
			...templateFromRow(row),
			origin: row.origin,
		}));
	}

	async currentVersion(
		tenantId: string,
		key: string,
	): Promise<CurrentTemplateVersion | null> {
		return this.database.transaction(
			async (transaction) => {
				const template = (
					await transaction.query<TemplateRow>({
						text: SQL.findTemplate,
						parameters: [tenantId, key],
					})
				).rows[0];
				if (!template) return null;
				const version = (
					await transaction.query<VersionRow>({
						text: SQL.findVersion,
						parameters: [
							tenantId,
							key,
							whole(template.current_version, 'version'),
						],
					})
				).rows[0];
				if (!version) {
					throw new Error(
						'A document template names a version that does not exist.',
					);
				}
				return {
					template: templateFromRow(template),
					version: versionFromRow(version),
				};
			},
			{ access: 'read', tenantId },
		);
	}

	async findVersion(tenantId: string, key: string, version: number) {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<VersionRow>({
					text: SQL.findVersion,
					parameters: [tenantId, key, version],
				}),
			{ access: 'read', tenantId },
		);
		const row = result.rows[0];
		return row ? versionFromRow(row) : null;
	}

	async listVersions(
		tenantId: string,
		key: string,
		limit: number,
		before: number | null,
	) {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<
					Omit<
						VersionRow,
						| 'tenant_id'
						| 'template_key'
						| 'body'
						| 'layout'
						| 'input_schema'
						| 'locale'
						| 'format'
					>
				>({
					text: SQL.listVersions,
					parameters: [tenantId, key, before, limit],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map((row) => ({
			version: whole(row.version, 'version'),
			origin: row.origin,
			contentSha256: row.content_sha256,
			createdBy: row.created_by,
			createdAt: whole(row.created_at, 'timestamp'),
		}));
	}

	async appendVersions(
		input: Parameters<DocumentTemplatesRepository['appendVersions']>[0],
	) {
		const { tenantId, key } = input;
		return this.database.transaction(
			async (
				transaction,
			): Promise<readonly TemplateVersionRecord[] | 'conflict'> => {
				const locked = (
					await transaction.query<{ current_version: Numeric }>({
						text: SQL.lockTemplate,
						parameters: [tenantId, key],
					})
				).rows[0];
				const current = locked ? whole(locked.current_version, 'version') : 0;
				if (current !== input.expectedVersion) return 'conflict';
				const last = current + input.contents.length;
				const moved = locked
					? await transaction.execute({
							text: SQL.advanceTemplate,
							parameters: [tenantId, key, current, last, input.actor, input.at],
						})
					: await transaction.execute({
							text: SQL.insertTemplate,
							parameters: [
								tenantId,
								key,
								input.ownerModule,
								last,
								input.actor,
								input.at,
							],
						});
				if (moved.affectedRows === 0) return 'conflict';
				const versions: TemplateVersionRecord[] = [];
				for (const [offset, content] of input.contents.entries()) {
					const row = (
						await transaction.query<VersionRow>({
							text: SQL.insertVersion,
							parameters: [
								tenantId,
								key,
								current + offset + 1,
								content.origin,
								content.body,
								content.layout,
								content.inputSchema,
								content.locale,
								content.format,
								content.contentSha256,
								input.actor,
								input.at,
							],
						})
					).rows[0]!;
					versions.push(versionFromRow(row));
				}
				return versions;
			},
			{ access: 'write', tenantId },
		);
	}

	async createRender(render: NewRender) {
		const tenantId = render.tenantId;
		return this.database.transaction(
			async (transaction) => {
				const inserted = (
					await transaction.query<RenderRow>({
						text: SQL.createRender,
						parameters: [
							render.id,
							tenantId,
							render.templateKey,
							render.version,
							render.ownerModule,
							render.recordRef,
							render.inputDigest,
							render.input,
							render.format,
							render.requestedBy,
							render.createdAt,
						],
					})
				).rows[0];
				if (inserted) return { render: renderFromRow(inserted), created: true };
				const existing = (
					await transaction.query<RenderRow>({
						text: SQL.findRenderByTuple,
						parameters: [
							tenantId,
							render.templateKey,
							render.version,
							render.ownerModule,
							render.recordRef,
							render.format,
							render.inputDigest,
						],
					})
				).rows[0];
				if (!existing)
					throw new Error('The document render vanished while it was written.');
				return { render: renderFromRow(existing), created: false };
			},
			{ access: 'write', tenantId },
		);
	}

	async findRender(tenantId: string, id: string) {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<RenderRow>({
					text: SQL.findRender,
					parameters: [tenantId, id],
				}),
			{ access: 'read', tenantId },
		);
		const row = result.rows[0];
		return row ? renderFromRow(row) : null;
	}

	async findRenderKey(tenantId: string, key: string) {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<{ request_sha256: string; render_id: string }>({
					text: SQL.findRenderKey,
					parameters: [tenantId, key],
				}),
			{ access: 'read', tenantId },
		);
		const row = result.rows[0];
		return row
			? { requestSha256: row.request_sha256, renderId: row.render_id }
			: null;
	}

	async bindRenderKey(
		input: Parameters<DocumentTemplatesRepository['bindRenderKey']>[0],
	) {
		const { tenantId } = input;
		return this.database.transaction(
			async (transaction) => {
				const inserted = (
					await transaction.query<{
						request_sha256: string;
						render_id: string;
					}>({
						text: SQL.bindRenderKey,
						parameters: [
							tenantId,
							input.key,
							input.requestSha256,
							input.renderId,
							input.at,
						],
					})
				).rows[0];
				const row =
					inserted ??
					(
						await transaction.query<{
							request_sha256: string;
							render_id: string;
						}>({
							text: SQL.findRenderKey,
							parameters: [tenantId, input.key],
						})
					).rows[0];
				if (!row)
					throw new Error('The render key vanished while it was bound.');
				return { requestSha256: row.request_sha256, renderId: row.render_id };
			},
			{ access: 'write', tenantId },
		);
	}

	rebindRenderKey(
		input: Parameters<DocumentTemplatesRepository['rebindRenderKey']>[0],
	) {
		return this.#fenced(input.tenantId, SQL.rebindRenderKey, [
			input.tenantId,
			input.key,
			input.from,
			input.to,
		]);
	}

	async requeueRender(
		input: Parameters<DocumentTemplatesRepository['requeueRender']>[0],
	) {
		const row = await this.#writeRender(input.tenantId, SQL.requeueRender, [
			input.tenantId,
			input.id,
			input.observed,
			input.input,
			input.requestedBy,
			input.nextGeneration ? 1 : 0,
		]);
		return row ? renderFromRow(row) : null;
	}

	async listPendingRenders(limit: number, staleBefore: number) {
		if (!this.background) {
			throw new Error('The documents render runner needs a background handle.');
		}
		const result = await this.background.query<{
			id: string;
			tenant_id: string;
			created_at: Numeric;
		}>({
			text: SQL.listPendingRenders,
			parameters: [limit, staleBefore],
		});
		return result.rows.map((row) => ({
			id: row.id,
			tenantId: row.tenant_id,
			createdAt: whole(row.created_at, 'timestamp'),
		}));
	}

	async claimRender(
		input: Parameters<DocumentTemplatesRepository['claimRender']>[0],
	) {
		const row = await this.#writeRender(input.tenantId, SQL.claimRender, [
			input.tenantId,
			input.id,
			input.claimedBy,
			input.claimedAt,
			input.staleBefore,
		]);
		return row ? { ...renderFromRow(row), claimedBy: input.claimedBy } : null;
	}

	heartbeatRender(tenantId: string, id: string, claimedBy: string, at: number) {
		return this.#fenced(tenantId, SQL.heartbeatRender, [
			tenantId,
			id,
			claimedBy,
			at,
		]);
	}

	async completeRender(
		input: Parameters<DocumentTemplatesRepository['completeRender']>[0],
	) {
		const { tenantId, document } = input;
		return this.database.transaction(
			async (transaction) => {
				const settled = await transaction.execute({
					text: SQL.completeRender,
					parameters: [
						tenantId,
						input.id,
						input.claimedBy,
						document.id,
						input.at,
					],
				});
				if (settled.affectedRows === 0) return false;
				await transaction.execute({
					text: SQL.insertDocument,
					parameters: [
						document.id,
						document.tenantId,
						document.ownerModule,
						document.recordRef,
						document.filename,
						document.contentType,
						document.bytes,
						document.checksum,
						document.storageKey,
						document.uploaderAccountId,
						document.scan,
						document.status,
						document.description,
						document.createdAt,
					],
				});
				return true;
			},
			{ access: 'write', tenantId },
		);
	}

	failRender(
		tenantId: string,
		id: string,
		claimedBy: string,
		errorCode: string,
		at: number,
	) {
		return this.#fenced(tenantId, SQL.failRender, [
			tenantId,
			id,
			claimedBy,
			errorCode,
			at,
		]);
	}

	releaseRender(tenantId: string, id: string, claimedBy: string) {
		return this.#fenced(tenantId, SQL.releaseRender, [tenantId, id, claimedBy]);
	}

	async sweepRenders(tenantId: string, cutoff: number, limit: number) {
		const result = await this.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: SQL.sweepRenderKeys,
					parameters: [tenantId, cutoff, limit],
				});
				await transaction.execute({
					text: SQL.sweepLostRenderKeys,
					parameters: [tenantId, cutoff, limit],
				});
				return transaction.execute({
					text: SQL.sweepRenders,
					parameters: [tenantId, cutoff, limit],
				});
			},
			{ access: 'write', tenantId },
		);
		return result.affectedRows;
	}

	async exportVersions(
		tenantId: string,
		after: { key: string; version: number } | null,
		limit: number,
	) {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<VersionRow>({
					text: SQL.exportVersions,
					parameters: [
						tenantId,
						after?.key ?? null,
						after?.version ?? null,
						limit,
					],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(versionFromRow);
	}

	async exportRenders(
		tenantId: string,
		after: { createdAt: number; id: string } | null,
		limit: number,
	) {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<RenderRow>({
					text: SQL.exportRenders,
					parameters: [
						tenantId,
						after?.createdAt ?? null,
						after?.id ?? null,
						limit,
					],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(renderFromRow);
	}

	async #writeRender(
		tenantId: string,
		text: string,
		parameters: readonly DatabaseParameter[],
	) {
		const result = await this.database.transaction(
			(transaction) => transaction.query<RenderRow>({ text, parameters }),
			{ access: 'write', tenantId },
		);
		return result.rows[0] ?? null;
	}

	async #fenced(
		tenantId: string,
		text: string,
		parameters: readonly DatabaseParameter[],
	) {
		const result = await this.database.transaction(
			(transaction) => transaction.execute({ text, parameters }),
			{ access: 'write', tenantId },
		);
		return result.affectedRows > 0;
	}
}
