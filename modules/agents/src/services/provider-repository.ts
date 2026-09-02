import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { modelSupportsTemperature } from '@coreloom/harness/catalog';
import { runModuleMigrations } from '@coreloom/kernel';
import type {
	AgentModelReadiness,
	AgentProviderConnection,
	AgentProviderModel,
	AgentProviderModelConfiguration,
} from '../domain/types.ts';
import type { EncryptedCredential } from './credential-vault.ts';
import { migrations } from './migration.ts';

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
	readiness_latency_ms: number | null;
	readiness_error_code: string | null;
	readiness_checked_at: number | null;
	revision: number;
	created_by: string;
	created_at: number;
	updated_by: string;
	updated_at: number;
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
	latency_ms: number | null;
	error_code: string | null;
	checked_at: number;
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
		const models = result.get(row.provider_id) ?? new Map();
		models.set(row.model_id, {
			status: row.status,
			latencyMs: row.latency_ms,
			errorCode: row.error_code,
			checkedAt: row.checked_at,
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
			createdAt: row.created_at,
			updatedBy: row.updated_by,
			updatedAt: row.updated_at,
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
	list(tenantId: string): readonly AgentProviderConnection[];
	get(tenantId: string, id: string): StoredProviderConnection | null;
	create(value: StoredProviderConnection): AgentProviderConnection;
	update(value: StoredProviderConnection): AgentProviderConnection;
	delete(tenantId: string, id: string): boolean;
	recordReadiness(
		tenantId: string,
		id: string,
		modelId: string,
		readiness: AgentModelReadiness,
		actorId: string,
		updatedAt: number,
	): AgentProviderConnection;
	/* Evidence a change invalidated. Pass null to drop every model's. */
	clearReadiness(
		tenantId: string,
		id: string,
		modelIds: readonly string[] | null,
	): void;
	/* Evidence from a run that answered. Touches the model only, never the
	   connection's revision or author. */
	refreshReadiness(
		tenantId: string,
		id: string,
		modelId: string,
		readiness: AgentModelReadiness,
	): void;
}

export class SqliteProviderRepository implements ProviderRepository {
	readonly #database: DatabaseSync;
	#closed = false;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5_000 });
		this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
		runModuleMigrations(this.#database, migrations);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#database.close();
	}

	/* Deployment-wide counts for operator tooling; no tenant data. */
	summary(): { readonly connections: number; readonly enabled: number } {
		const row = this.#database
			.prepare(
				`SELECT COUNT(*) AS connections, COALESCE(SUM(enabled), 0) AS enabled
				 FROM agent_provider_connections`,
			)
			.get() as unknown as { connections: number; enabled: number };
		return { connections: row.connections, enabled: row.enabled };
	}

	list(tenantId: string): readonly AgentProviderConnection[] {
		const readiness = readinessMap(
			this.#database
				.prepare(
					`SELECT r.* FROM agent_provider_model_readiness r
					 JOIN agent_provider_connections c ON c.id = r.provider_id
					 WHERE c.tenant_id = ?`,
				)
				.all(tenantId) as unknown as ReadinessRow[],
		);
		return (
			this.#database
				.prepare(
					`SELECT * FROM agent_provider_connections WHERE tenant_id = ?
					 ORDER BY lower(name), id`,
				)
				.all(tenantId) as unknown as ProviderRow[]
		).map((row) => fromRow(row, readiness.get(row.id) ?? new Map()).connection);
	}

	get(tenantId: string, id: string): StoredProviderConnection | null {
		const row = this.#database
			.prepare(
				'SELECT * FROM agent_provider_connections WHERE tenant_id = ? AND id = ?',
			)
			.get(tenantId, id) as unknown as ProviderRow | undefined;
		return row ? fromRow(row, this.#readinessFor(id)) : null;
	}

	#readinessFor(providerId: string): ReadonlyMap<string, AgentModelReadiness> {
		return (
			readinessMap(
				this.#database
					.prepare(
						'SELECT * FROM agent_provider_model_readiness WHERE provider_id = ?',
					)
					.all(providerId) as unknown as ReadinessRow[],
			).get(providerId) ?? new Map()
		);
	}

	create(value: StoredProviderConnection): AgentProviderConnection {
		const item = value.connection;
		try {
			this.#database
				.prepare(
					`INSERT INTO agent_provider_connections
				 (id, tenant_id, provider_key, name, kind, enabled, resource_name,
				  base_url, models_json, credential_key_id, credential_iv,
				  credential_tag, credential_ciphertext, credential_revision,
				  readiness_status, readiness_model, readiness_latency_ms,
				  readiness_error_code, readiness_checked_at, revision, created_by,
				  created_at, updated_by, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
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
				);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.includes('agent_provider_connections.tenant_id')
			) {
				throw new DuplicateProviderKeyError();
			}
			throw error;
		}
		return item;
	}

	update(value: StoredProviderConnection): AgentProviderConnection {
		const item = value.connection;
		const result = this.#database
			.prepare(
				`UPDATE agent_provider_connections SET name = ?, enabled = ?,
				 resource_name = ?, base_url = ?, models_json = ?,
				 credential_key_id = ?, credential_iv = ?, credential_tag = ?,
				 credential_ciphertext = ?, credential_revision = ?, revision = ?,
				 updated_by = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
			)
			.run(
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
			);
		if (result.changes !== 1) throw new Error('Provider connection not found.');
		return item;
	}

	delete(tenantId: string, id: string): boolean {
		return (
			this.#database
				.prepare(
					'DELETE FROM agent_provider_connections WHERE tenant_id = ? AND id = ?',
				)
				.run(tenantId, id).changes === 1
		);
	}

	recordReadiness(
		tenantId: string,
		id: string,
		modelId: string,
		readiness: AgentModelReadiness,
		actorId: string,
		updatedAt: number,
	): AgentProviderConnection {
		if (readiness.status === 'unknown' || readiness.checkedAt === null) {
			throw new Error('Recorded readiness must carry a probe result.');
		}
		const owned = this.#database
			.prepare(
				'SELECT id FROM agent_provider_connections WHERE tenant_id = ? AND id = ?',
			)
			.get(tenantId, id);
		if (!owned) throw new Error('Provider connection not found.');
		this.#upsertReadiness(id, modelId, readiness);
		/* The connection columns keep the last probe so a later migration can
		   still read where the evidence came from. */
		this.#database
			.prepare(
				`UPDATE agent_provider_connections SET readiness_status = ?,
				 readiness_model = ?, readiness_latency_ms = ?, readiness_error_code = ?,
				 readiness_checked_at = ?, updated_by = ?, updated_at = ?
				 WHERE tenant_id = ? AND id = ?`,
			)
			.run(
				readiness.status,
				modelId,
				readiness.latencyMs,
				readiness.errorCode,
				readiness.checkedAt,
				actorId,
				updatedAt,
				tenantId,
				id,
			);
		return this.get(tenantId, id)!.connection;
	}

	refreshReadiness(
		tenantId: string,
		id: string,
		modelId: string,
		readiness: AgentModelReadiness,
	): void {
		if (readiness.status === 'unknown' || readiness.checkedAt === null) {
			throw new Error('Recorded readiness must carry a probe result.');
		}
		const owned = this.#database
			.prepare(
				'SELECT id FROM agent_provider_connections WHERE tenant_id = ? AND id = ?',
			)
			.get(tenantId, id);
		if (!owned) throw new Error('Provider connection not found.');
		this.#upsertReadiness(id, modelId, readiness);
	}

	#upsertReadiness(
		id: string,
		modelId: string,
		readiness: AgentModelReadiness,
	): void {
		this.#database
			.prepare(
				`INSERT INTO agent_provider_model_readiness
				 (provider_id, model_id, status, latency_ms, error_code, checked_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT (provider_id, model_id) DO UPDATE SET
				   status = excluded.status, latency_ms = excluded.latency_ms,
				   error_code = excluded.error_code, checked_at = excluded.checked_at`,
			)
			.run(
				id,
				modelId,
				readiness.status,
				readiness.latencyMs,
				readiness.errorCode,
				readiness.checkedAt,
			);
	}

	clearReadiness(
		tenantId: string,
		id: string,
		modelIds: readonly string[] | null,
	): void {
		const owned = this.#database
			.prepare(
				'SELECT id FROM agent_provider_connections WHERE tenant_id = ? AND id = ?',
			)
			.get(tenantId, id);
		if (!owned) throw new Error('Provider connection not found.');
		if (modelIds === null) {
			this.#database
				.prepare(
					'DELETE FROM agent_provider_model_readiness WHERE provider_id = ?',
				)
				.run(id);
			return;
		}
		const statement = this.#database.prepare(
			`DELETE FROM agent_provider_model_readiness
			 WHERE provider_id = ? AND model_id = ?`,
		);
		for (const modelId of modelIds) statement.run(id, modelId);
	}
}
