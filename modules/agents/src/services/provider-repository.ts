import type { DatabaseHandle, DatabaseTransaction } from '@flowdular/database';
import { integer } from '@flowdular/database';
import { modelSupportsTemperature } from '@flowdular/harness/catalog';
import type {
	AgentModelReadiness,
	AgentProviderConnection,
	AgentProviderModel,
	AgentProviderModelConfiguration,
} from '../domain/types.ts';
import type { EncryptedCredential } from './credential-vault.ts';

export class DuplicateProviderKeyError extends Error {
	constructor() {
		super(
			'A provider connection with this key already exists in the active tenant.',
		);
		this.name = 'DuplicateProviderKeyError';
	}
}

interface ProviderRow {
	id: string;
	tenant_id: string;
	provider_key: string;
	name: string;
	kind: Exclude<AgentProviderConnection['kind'], 'local-simulation'>;
	enabled: number;
	resource_name: string | null;
	base_url: string | null;
	models_json: string;
	credential_key_id: string;
	credential_iv: string;
	credential_tag: string;
	credential_ciphertext: string;
	credential_revision: number;
	readiness_status: 'unknown' | 'healthy' | 'unhealthy';
	readiness_model: string | null;
	readiness_latency_ms: Int | null;
	readiness_error_code: string | null;
	readiness_checked_at: Int | null;
	revision: number;
	created_by: string;
	created_at: Int;
	updated_by: string;
	updated_at: Int;
}

export interface StoredProviderConnection {
	readonly connection: AgentProviderConnection;
	readonly credential: EncryptedCredential;
}

const UNPROVEN: AgentModelReadiness = {
	status: 'unknown',
	latencyMs: null,
	errorCode: null,
	checkedAt: null,
};

interface ReadinessRow {
	provider_id: string;
	model_id: string;
	status: 'healthy' | 'unhealthy';
	latency_ms: Int | null;
	error_code: string | null;
	checked_at: Int;
}

/* models_json holds configuration only. Readiness is evidence and lives in its
   own table, so saving a model never rewrites what a probe proved. */
function models(
	value: string,
	kind: ProviderRow['kind'],
	readiness: ReadonlyMap<string, AgentModelReadiness>,
): readonly AgentProviderModel[] {
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed))
		throw new Error('Stored provider models are invalid.');
	return (parsed as AgentProviderModelConfiguration[]).map((model) => ({
		...model,
		supportsTemperature:
			model.supportsTemperature ?? modelSupportsTemperature(kind, model.id),
		readiness: readiness.get(model.id) ?? UNPROVEN,
	}));
}

function modelConfiguration(
	value: readonly AgentProviderModel[],
): readonly AgentProviderModelConfiguration[] {
	return value.map((model) => ({
		id: model.id,
		label: model.label,
		enabled: model.enabled,
		supportsTools: model.supportsTools,
		supportsStreaming: model.supportsStreaming,
		supportsWebSearch: model.supportsWebSearch,
		supportsTemperature: model.supportsTemperature,
	}));
}

function readinessMap(
	rows: readonly ReadinessRow[],
): Map<string, Map<string, AgentModelReadiness>> {
	const result = new Map<string, Map<string, AgentModelReadiness>>();
	for (const row of rows) {
		const models =
			result.get(row.provider_id) ?? new Map<string, AgentModelReadiness>();
		models.set(row.model_id, {
			status: row.status,
			latencyMs: integerOrNull(row.latency_ms, 'latency_ms'),
			errorCode: row.error_code,
			checkedAt: integer(row.checked_at, 'checked_at'),
		});
		result.set(row.provider_id, models);
	}
	return result;
}

function fromRow(
	row: ProviderRow,
	readiness: ReadonlyMap<string, AgentModelReadiness>,
): StoredProviderConnection {
	return {
		connection: {
			id: row.id,
			tenantId: row.tenant_id,
			key: row.provider_key,
			name: row.name,
			kind: row.kind,
			enabled: row.enabled === 1,
			resourceName: row.resource_name,
			baseURL: row.base_url,
			models: models(row.models_json, row.kind, readiness),
			credentialConfigured: true,
			credentialRevision: row.credential_revision,
			revision: row.revision,
			createdBy: row.created_by,
			createdAt: integer(row.created_at, 'created_at'),
			updatedBy: row.updated_by,
			updatedAt: integer(row.updated_at, 'updated_at'),
		},
		credential: {
			keyId: row.credential_key_id,
			iv: row.credential_iv,
			tag: row.credential_tag,
			ciphertext: row.credential_ciphertext,
		},
	};
}

export interface ProviderRepository {
	close(): Promise<void>;
	list(tenantId: string): Promise<readonly AgentProviderConnection[]>;
	get(tenantId: string, id: string): Promise<StoredProviderConnection | null>;
	create(value: StoredProviderConnection): Promise<AgentProviderConnection>;
	update(value: StoredProviderConnection): Promise<AgentProviderConnection>;
	delete(tenantId: string, id: string): Promise<boolean>;
	recordReadiness(
		tenantId: string,
		id: string,
		modelId: string,
		readiness: AgentModelReadiness,
		actorId: string,
		updatedAt: number,
	): Promise<AgentProviderConnection>;
	/* Evidence a change invalidated. Pass null to drop every model's. */
	clearReadiness(
		tenantId: string,
		id: string,
		modelIds: readonly string[] | null,
	): Promise<void>;
	/* Evidence from a run that answered. Touches the model only, never the
	   connection's revision or author. */
	refreshReadiness(
		tenantId: string,
		id: string,
		modelId: string,
		readiness: AgentModelReadiness,
	): Promise<void>;
}

type Int = number | bigint | string;

/* A nullable BIGINT must stay null: coercing it to 0 would turn "never checked"
   into "checked at the epoch". */
function integerOrNull(value: Int | null, field: string): number | null {
	return value === null ? null : integer(value, field);
}

export interface ProvidersPersistenceStatements {
	readonly summary: string;
	readonly list1: string;
	readonly list2: string;
	readonly get: string;
	readonly readinessFor: string;
	readonly create: string;
	readonly update: string;
	readonly delete: string;
	readonly recordReadiness1: string;
	readonly recordReadiness2: string;
	readonly refreshReadiness: string;
	readonly upsertReadiness: string;
	readonly clearReadiness1: string;
	readonly clearReadiness2: string;
	readonly clearReadiness3: string;
}

/* Every statement is PostgreSQL; the platform has no second dialect. */
export const PROVIDERS_SQL: ProvidersPersistenceStatements = Object.freeze({
	summary: `SELECT COUNT(*) AS connections, COALESCE(SUM(enabled), 0) AS enabled
				 FROM agent_provider_connections`,
	list1: `SELECT r.* FROM agent_provider_model_readiness r
					 JOIN agent_provider_connections c ON c.id = r.provider_id
					 WHERE c.tenant_id = $1`,
	list2: `SELECT * FROM agent_provider_connections WHERE tenant_id = $1
					 ORDER BY lower(name), id`,
	get: `SELECT * FROM agent_provider_connections WHERE tenant_id = $1 AND id = $2`,
	readinessFor: `SELECT * FROM agent_provider_model_readiness
			 WHERE tenant_id = $1 AND provider_id = $2`,
	create: `INSERT INTO agent_provider_connections
				 (id, tenant_id, provider_key, name, kind, enabled, resource_name,
				  base_url, models_json, credential_key_id, credential_iv,
				  credential_tag, credential_ciphertext, credential_revision,
				  readiness_status, readiness_model, readiness_latency_ms,
				  readiness_error_code, readiness_checked_at, revision, created_by,
				  created_at, updated_by, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
	update: `UPDATE agent_provider_connections SET name = $1, enabled = $2,
				 resource_name = $3, base_url = $4, models_json = $5,
				 credential_key_id = $6, credential_iv = $7, credential_tag = $8,
				 credential_ciphertext = $9, credential_revision = $10, revision = $11,
				 updated_by = $12, updated_at = $13 WHERE tenant_id = $14 AND id = $15`,
	delete: `DELETE FROM agent_provider_connections WHERE tenant_id = $1 AND id = $2`,
	recordReadiness1: `SELECT id FROM agent_provider_connections WHERE tenant_id = $1 AND id = $2`,
	recordReadiness2: `UPDATE agent_provider_connections SET readiness_status = $1,
				 readiness_model = $2, readiness_latency_ms = $3, readiness_error_code = $4,
				 readiness_checked_at = $5, updated_by = $6, updated_at = $7
				 WHERE tenant_id = $8 AND id = $9`,
	refreshReadiness: `SELECT id FROM agent_provider_connections WHERE tenant_id = $1 AND id = $2`,
	upsertReadiness: `INSERT INTO agent_provider_model_readiness
				 (provider_id, tenant_id, model_id, status, latency_ms, error_code,
				  checked_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)
				 ON CONFLICT (provider_id, model_id) DO UPDATE SET
				   status = excluded.status, latency_ms = excluded.latency_ms,
				   error_code = excluded.error_code, checked_at = excluded.checked_at`,
	clearReadiness1: `SELECT id FROM agent_provider_connections WHERE tenant_id = $1 AND id = $2`,
	clearReadiness2: `DELETE FROM agent_provider_model_readiness
			 WHERE tenant_id = $1 AND provider_id = $2`,
	clearReadiness3: `DELETE FROM agent_provider_model_readiness
			 WHERE tenant_id = $1 AND provider_id = $2 AND model_id = $3`,
});

/** A dialect-neutral provider repository over a platform-owned handle. */
export class DatabaseProviderRepository implements ProviderRepository {
	constructor(
		private readonly handle: DatabaseHandle,
		private readonly readyPromise: Promise<void> = Promise.resolve(),
		/* Deployment-wide counts cross tenants, so they read the narrow role
		   rather than the tenant-scoped one. Absent means summary() refuses. */
		private readonly background?: DatabaseHandle,
	) {}

	async #tx<T>(
		tenantId: string,
		access: 'read' | 'write',
		body: (transaction: DatabaseTransaction) => Promise<T>,
	): Promise<T> {
		await this.readyPromise;
		return this.handle.transaction(body, { access, tenantId });
	}

	async #query<Row extends object>(
		transaction: DatabaseTransaction,
		text: string,
		parameters: readonly unknown[],
	): Promise<readonly Row[]> {
		const result = await transaction.query<Row>({
			text,
			parameters: parameters as never,
		});
		return result.rows;
	}

	async #exec(
		transaction: DatabaseTransaction,
		text: string,
		parameters: readonly unknown[],
	): Promise<number> {
		const result = await transaction.execute({
			text,
			parameters: parameters as never,
		});
		return result.affectedRows;
	}

	async close(): Promise<void> {}

	/* Deployment-wide counts for operator tooling; no tenant data, so it runs
	   on the same handle without a tenant context. */
	async summary(): Promise<{
		readonly connections: number;
		readonly enabled: number;
	}> {
		await this.readyPromise;
		if (!this.background) {
			throw new Error(
				'A deployment-wide provider summary needs the cross-tenant read handle.',
			);
		}
		const result = await this.background.transaction(
			(transaction) =>
				transaction.query<{ connections: Int; enabled: Int }>({
					text: PROVIDERS_SQL.summary,
				}),
			{ access: 'read' },
		);
		const row = result.rows[0]!;
		return {
			connections: integer(row.connections, 'connections'),
			enabled: integer(row.enabled, 'enabled'),
		};
	}

	async list(tenantId: string): Promise<readonly AgentProviderConnection[]> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const readiness = readinessMap(
				(await this.#query(transaction, PROVIDERS_SQL.list1, [
					tenantId,
				])) as unknown as ReadinessRow[],
			);
			return (
				(await this.#query(transaction, PROVIDERS_SQL.list2, [
					tenantId,
				])) as unknown as ProviderRow[]
			).map(
				(row) => fromRow(row, readiness.get(row.id) ?? new Map()).connection,
			);
		});
	}

	get(tenantId: string, id: string): Promise<StoredProviderConnection | null> {
		return this.#tx(tenantId, 'read', (transaction) =>
			this.#get(transaction, tenantId, id),
		);
	}

	/* A transaction pins one connection, so work already inside one reads
	   through it instead of asking the handle for a second. */
	async #get(
		transaction: DatabaseTransaction,
		tenantId: string,
		id: string,
	): Promise<StoredProviderConnection | null> {
		const row = (
			await this.#query(transaction, PROVIDERS_SQL.get, [tenantId, id])
		)[0] as unknown as ProviderRow | undefined;
		return row
			? fromRow(row, await this.#readinessFor(transaction, tenantId, id))
			: null;
	}

	async #readinessFor(
		transaction: DatabaseTransaction,
		tenantId: string,
		providerId: string,
	): Promise<ReadonlyMap<string, AgentModelReadiness>> {
		return (
			readinessMap(
				(await this.#query(transaction, PROVIDERS_SQL.readinessFor, [
					tenantId,
					providerId,
				])) as unknown as ReadinessRow[],
			).get(providerId) ?? new Map()
		);
	}

	async create(
		value: StoredProviderConnection,
	): Promise<AgentProviderConnection> {
		return this.#tx(value.connection.tenantId, 'write', async (transaction) => {
			const item = value.connection;
			try {
				await this.#exec(transaction, PROVIDERS_SQL.create, [
					item.id,
					item.tenantId,
					item.key,
					item.name,
					item.kind,
					item.enabled ? 1 : 0,
					item.resourceName,
					item.baseURL,
					JSON.stringify(modelConfiguration(item.models)),
					value.credential.keyId,
					value.credential.iv,
					value.credential.tag,
					value.credential.ciphertext,
					item.credentialRevision,
					'unknown',
					null,
					null,
					null,
					null,
					item.revision,
					item.createdBy,
					item.createdAt,
					item.updatedBy,
					item.updatedAt,
				]);
			} catch (error) {
				if (
					error instanceof Error &&
					error.message.includes(
						'agent_provider_connections_tenant_id_provider_key_key',
					)
				) {
					throw new DuplicateProviderKeyError();
				}
				throw error;
			}
			return item;
		});
	}

	async update(
		value: StoredProviderConnection,
	): Promise<AgentProviderConnection> {
		return this.#tx(value.connection.tenantId, 'write', async (transaction) => {
			const item = value.connection;
			const result = await this.#exec(transaction, PROVIDERS_SQL.update, [
				item.name,
				item.enabled ? 1 : 0,
				item.resourceName,
				item.baseURL,
				JSON.stringify(modelConfiguration(item.models)),
				value.credential.keyId,
				value.credential.iv,
				value.credential.tag,
				value.credential.ciphertext,
				item.credentialRevision,
				item.revision,
				item.updatedBy,
				item.updatedAt,
				item.tenantId,
				item.id,
			]);
			if (result !== 1) throw new Error('Provider connection not found.');
			return item;
		});
	}

	async delete(tenantId: string, id: string): Promise<boolean> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			return (
				(await this.#exec(transaction, PROVIDERS_SQL.delete, [
					tenantId,
					id,
				])) === 1
			);
		});
	}

	async recordReadiness(
		tenantId: string,
		id: string,
		modelId: string,
		readiness: AgentModelReadiness,
		actorId: string,
		updatedAt: number,
	): Promise<AgentProviderConnection> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			if (readiness.status === 'unknown' || readiness.checkedAt === null) {
				throw new Error('Recorded readiness must carry a probe result.');
			}
			const owned = (
				await this.#query(transaction, PROVIDERS_SQL.recordReadiness1, [
					tenantId,
					id,
				])
			)[0];
			if (!owned) throw new Error('Provider connection not found.');
			await this.#upsertReadiness(
				transaction,
				tenantId,
				id,
				modelId,
				readiness,
			);
			/* The connection columns keep the last probe so a later migration can
			   still read where the evidence came from. */
			await this.#exec(transaction, PROVIDERS_SQL.recordReadiness2, [
				readiness.status,
				modelId,
				readiness.latencyMs,
				readiness.errorCode,
				readiness.checkedAt,
				actorId,
				updatedAt,
				tenantId,
				id,
			]);
			return (await this.#get(transaction, tenantId, id))!.connection;
		});
	}

	async refreshReadiness(
		tenantId: string,
		id: string,
		modelId: string,
		readiness: AgentModelReadiness,
	): Promise<void> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			if (readiness.status === 'unknown' || readiness.checkedAt === null) {
				throw new Error('Recorded readiness must carry a probe result.');
			}
			const owned = (
				await this.#query(transaction, PROVIDERS_SQL.refreshReadiness, [
					tenantId,
					id,
				])
			)[0];
			if (!owned) throw new Error('Provider connection not found.');
			await this.#upsertReadiness(
				transaction,
				tenantId,
				id,
				modelId,
				readiness,
			);
		});
	}

	async #upsertReadiness(
		transaction: DatabaseTransaction,
		tenantId: string,
		id: string,
		modelId: string,
		readiness: AgentModelReadiness,
	): Promise<void> {
		await this.#exec(transaction, PROVIDERS_SQL.upsertReadiness, [
			id,
			tenantId,
			modelId,
			readiness.status,
			readiness.latencyMs,
			readiness.errorCode,
			readiness.checkedAt,
		]);
	}

	async clearReadiness(
		tenantId: string,
		id: string,
		modelIds: readonly string[] | null,
	): Promise<void> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			const owned = (
				await this.#query(transaction, PROVIDERS_SQL.clearReadiness1, [
					tenantId,
					id,
				])
			)[0];
			if (!owned) throw new Error('Provider connection not found.');
			if (modelIds === null) {
				await this.#exec(transaction, PROVIDERS_SQL.clearReadiness2, [
					tenantId,
					id,
				]);
				return;
			}
			for (const modelId of modelIds) {
				await this.#exec(transaction, PROVIDERS_SQL.clearReadiness3, [
					tenantId,
					id,
					modelId,
				]);
			}
		});
	}
}
