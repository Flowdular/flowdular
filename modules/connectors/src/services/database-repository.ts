import { randomUUID } from 'node:crypto';
import type { DatabaseHandle, DatabaseParameter } from '@flowdular/database';
import { integer, runDatabaseMigrations } from '@flowdular/database';
import type {
	ConnectorAuditAction,
	ConnectorAuditEvent,
	ConnectorCall,
	ConnectorCaller,
	ConnectorCallOutcome,
	ConnectorAuthKind,
	ConnectorErrorClass,
	ConnectorInstance,
	ConnectorInstanceStatus,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import {
	DuplicateConnectorNameError,
	type ConnectorCallFilters,
	type ConnectorCallKeyClaim,
	type ConnectorCallKeyDecision,
	type ConnectorExportCursor,
	type ConnectorsRepository,
	type PendingConnectorAuditEvent,
	type StoredConnectorInstance,
} from './repository.ts';

interface InstanceRow {
	id: string;
	tenant_id: string;
	definition_key: string;
	name: string;
	base_url: string;
	auth_kind: string;
	credential_key_id: string | null;
	credential_iv: string | null;
	credential_tag: string | null;
	credential_ciphertext: string | null;
	credential_fingerprint: string | null;
	allowed_hosts_json: string;
	allow_workflows: number | bigint | string;
	allow_agents: number | bigint | string;
	status: string;
	last_call_at: number | bigint | string | null;
	created_at: number | bigint | string;
	updated_at: number | bigint | string;
}

interface CallRow {
	id: string;
	tenant_id: string;
	instance_id: string;
	operation: string;
	caller: string;
	caller_ref: string | null;
	outcome: string;
	status: number | bigint | string | null;
	error_class: string | null;
	duration_ms: number | bigint | string;
	request_bytes: number | bigint | string;
	response_bytes: number | bigint | string;
	occurred_at: number | bigint | string;
}

interface CallKeyRow {
	operation_id: string;
	input_digest: string;
	call_id: string | null;
	claimed_at: number | bigint | string;
}

interface AuditRow {
	id: string;
	tenant_id: string;
	actor_id: string;
	action: string;
	instance_id: string;
	metadata_json: string;
	occurred_at: number | bigint | string;
}

const INSTANCE_COLUMNS = `id, tenant_id, definition_key, name, base_url, auth_kind,
			 credential_key_id, credential_iv, credential_tag, credential_ciphertext,
			 credential_fingerprint, allowed_hosts_json, allow_workflows, allow_agents,
			 status, last_call_at, created_at, updated_at`;

const LIST_INSTANCES = `SELECT ${INSTANCE_COLUMNS}
			 FROM connectors_instances
			 WHERE tenant_id = $1
			 ORDER BY name_normalized, id`;

const FIND_INSTANCE = `SELECT ${INSTANCE_COLUMNS}
			 FROM connectors_instances
			 WHERE tenant_id = $1 AND id = $2`;

const INSERT_INSTANCE = `INSERT INTO connectors_instances
			 (id, tenant_id, definition_key, name, name_normalized, base_url, auth_kind,
			  credential_key_id, credential_iv, credential_tag, credential_ciphertext,
			  credential_fingerprint, allowed_hosts_json, allow_workflows, allow_agents,
			  status, last_call_at, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
			         $16, $17, $18, $19)`;

const UPDATE_INSTANCE = `UPDATE connectors_instances
			 SET name = $3, name_normalized = $4, base_url = $5,
			     credential_key_id = $6, credential_iv = $7, credential_tag = $8,
			     credential_ciphertext = $9, credential_fingerprint = $10,
			     allowed_hosts_json = $11, updated_at = $12
			 WHERE tenant_id = $1 AND id = $2`;

const SET_CONSENT = `UPDATE connectors_instances
			 SET allow_workflows = $3, allow_agents = $4, updated_at = $5
			 WHERE tenant_id = $1 AND id = $2`;

const SET_STATUS = `UPDATE connectors_instances
			 SET status = $3, updated_at = $4
			 WHERE tenant_id = $1 AND id = $2`;

/* Deleting is refused unless the instance is already disabled, in the same
   statement that deletes it: nothing between the check and the write. */
const DELETE_DISABLED_INSTANCE = `DELETE FROM connectors_instances
			 WHERE tenant_id = $1 AND id = $2 AND status = 'disabled'`;

const INSERT_CALL = `INSERT INTO connectors_calls
			 (id, tenant_id, instance_id, operation, caller, caller_ref, outcome,
			  status, error_class, duration_ms, request_bytes, response_bytes,
			  occurred_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`;

const TOUCH_LAST_CALL = `UPDATE connectors_instances
			 SET last_call_at = $3
			 WHERE tenant_id = $1 AND id = $2`;

const INSERT_AUDIT = `INSERT INTO connectors_audit
			 (id, tenant_id, actor_id, action, instance_id, metadata_json, occurred_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`;

const CALL_COLUMNS = `id, tenant_id, instance_id, operation, caller, caller_ref,
			 outcome, status, error_class, duration_ms, request_bytes,
			 response_bytes, occurred_at`;

const FIND_CALL = `SELECT ${CALL_COLUMNS}
			 FROM connectors_calls
			 WHERE tenant_id = $1 AND id = $2`;

const FIND_CALL_KEY = `SELECT operation_id, input_digest, call_id, claimed_at
			 FROM connectors_call_keys
			 WHERE tenant_id = $1 AND idempotency_key = $2`;

const INSERT_CALL_KEY = `INSERT INTO connectors_call_keys
			 (id, tenant_id, idempotency_key, operation_id, input_digest, call_id,
			  claimed_at, completed_at)
			 VALUES ($1, $2, $3, $4, $5, NULL, $6, NULL)`;

/* Retaking an abandoned claim keeps the row, so the unique key still refuses a
   second attempt that starts while this one runs. The previous claim time is
   part of the predicate: two attempts that read the same abandoned claim both
   reach this statement, and only the one whose read is still current may take
   it over. The loser updates nothing and is answered as in flight. */
const RETAKE_CALL_KEY = `UPDATE connectors_call_keys
			 SET claimed_at = $3
			 WHERE tenant_id = $1 AND idempotency_key = $2 AND call_id IS NULL
			   AND claimed_at = $4`;

const BIND_CALL_KEY = `UPDATE connectors_call_keys
			 SET call_id = $3, completed_at = $4
			 WHERE tenant_id = $1 AND idempotency_key = $2 AND call_id IS NULL`;

/* Keyset paging by an immutable key, so a walk terminates on a table that is
   still being written to and never holds more than one page. */
const EXPORT_CALLS = `SELECT ${CALL_COLUMNS}
			 FROM connectors_calls
			 WHERE tenant_id = $1 AND (occurred_at, id) > ($2, $3)
			 ORDER BY occurred_at, id
			 LIMIT $4`;

const DELETE_CALLS_BEFORE = `DELETE FROM connectors_calls
			 WHERE id IN (
			   SELECT id FROM connectors_calls
			   WHERE tenant_id = $1 AND occurred_at < $2
			   ORDER BY occurred_at, id
			   LIMIT $3
			 )`;

const DELETE_CALL_KEYS_BEFORE = `DELETE FROM connectors_call_keys
			 WHERE id IN (
			   SELECT id FROM connectors_call_keys
			   WHERE tenant_id = $1 AND claimed_at < $2
			   ORDER BY claimed_at, id
			   LIMIT $3
			 )`;

const EXPORT_AUDIT = `SELECT id, tenant_id, actor_id, action, instance_id,
			        metadata_json, occurred_at
			 FROM connectors_audit
			 WHERE tenant_id = $1 AND (occurred_at, id) > ($2, $3)
			 ORDER BY occurred_at, id
			 LIMIT $4`;

const EXPORT_INSTANCES = `SELECT ${INSTANCE_COLUMNS}
			 FROM connectors_instances
			 WHERE tenant_id = $1 AND (created_at, id) > ($2, $3)
			 ORDER BY created_at, id
			 LIMIT $4`;

const LIST_AUDIT = `SELECT id, tenant_id, actor_id, action, instance_id,
			        metadata_json, occurred_at
			 FROM connectors_audit
			 WHERE tenant_id = $1 AND instance_id = $2
			 ORDER BY occurred_at DESC, id DESC
			 LIMIT $3`;

/* 23505 is the SQLSTATE for a unique violation; the index name keeps another
   unique index on the table from being mistaken for the name. The driver text
   is never surfaced, only the stable domain error. */
function isDuplicateName(error: unknown): boolean {
	const cause = error as { code?: unknown; constraint?: unknown };
	const text = String(error);
	return (
		(cause?.code === '23505' || text.includes('23505')) &&
		(String(cause?.constraint ?? '').includes('name_normalized') ||
			text.includes('name_normalized'))
	);
}

/* PostgreSQL returns BIGINT as a string, so every integer read crosses this
   instead of trusting the driver's representation. */
/* The same SQLSTATE on the idempotency key: two attempts raced for the claim
   and the loser re-reads the row the winner wrote. */
function isDuplicateCallKey(error: unknown): boolean {
	const cause = error as { code?: unknown; constraint?: unknown };
	const text = String(error);
	return (
		(cause?.code === '23505' || text.includes('23505')) &&
		(String(cause?.constraint ?? '').includes('connectors_call_keys') ||
			text.includes('connectors_call_keys'))
	);
}

/* The flag columns are SMALLINT, the house shape for a boolean, so a driver
   that answers with a string is still read the same way. */
function flag(value: number | bigint | string): boolean {
	return Number(value) === 1;
}

function hosts(value: string): readonly string[] {
	const parsed: unknown = JSON.parse(value);
	return Array.isArray(parsed)
		? parsed.filter((entry): entry is string => typeof entry === 'string')
		: [];
}

/** The normalized name the unique index compares. */
export function normalizedInstanceName(name: string): string {
	return name.trim().toLocaleLowerCase('en-US');
}

function fromInstanceRow(row: InstanceRow): StoredConnectorInstance {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		definitionKey: row.definition_key,
		name: row.name,
		baseUrl: row.base_url,
		authKind: row.auth_kind as ConnectorAuthKind,
		credentialFingerprint: row.credential_fingerprint,
		allowedHosts: hosts(row.allowed_hosts_json),
		allowWorkflows: flag(row.allow_workflows),
		allowAgents: flag(row.allow_agents),
		status: row.status as ConnectorInstanceStatus,
		lastCallAt:
			row.last_call_at === null ? null : integer(row.last_call_at, 'timestamp'),
		createdAt: integer(row.created_at, 'timestamp'),
		updatedAt: integer(row.updated_at, 'timestamp'),
		credential:
			row.credential_ciphertext === null ||
			row.credential_iv === null ||
			row.credential_tag === null ||
			row.credential_key_id === null
				? null
				: {
						keyId: row.credential_key_id,
						iv: row.credential_iv,
						tag: row.credential_tag,
						ciphertext: row.credential_ciphertext,
					},
	};
}

/** Every reader outside the call path sees the instance without its envelope. */
export function withoutCredential(
	instance: StoredConnectorInstance,
): ConnectorInstance {
	const { credential: _credential, ...presented } = instance;
	return presented;
}

function fromCallRow(row: CallRow): ConnectorCall {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		instanceId: row.instance_id,
		operation: row.operation,
		caller: row.caller as ConnectorCaller,
		callerRef: row.caller_ref,
		outcome: row.outcome as ConnectorCallOutcome,
		status: row.status === null ? null : integer(row.status, 'status'),
		errorClass: row.error_class as ConnectorErrorClass | null,
		durationMs: integer(row.duration_ms, 'duration'),
		requestBytes: integer(row.request_bytes, 'byte count'),
		responseBytes: integer(row.response_bytes, 'byte count'),
		occurredAt: integer(row.occurred_at, 'timestamp'),
	};
}

function fromAuditRow(row: AuditRow): ConnectorAuditEvent {
	const parsed: unknown = JSON.parse(row.metadata_json);
	return {
		id: row.id,
		tenantId: row.tenant_id,
		actorId: row.actor_id,
		action: row.action as ConnectorAuditAction,
		instanceId: row.instance_id,
		metadata:
			parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as Record<string, string | number | boolean>)
				: {},
		occurredAt: integer(row.occurred_at, 'timestamp'),
	};
}

function auditParameters(audit: PendingConnectorAuditEvent) {
	return [
		randomUUID(),
		audit.tenantId,
		audit.actorId,
		audit.action,
		audit.instanceId,
		JSON.stringify(audit.metadata),
		audit.occurredAt,
	];
}

/** A repository over a platform-owned PostgreSQL handle. */
export class DatabaseConnectorsRepository implements ConnectorsRepository {
	constructor(private readonly database: DatabaseHandle) {}

	async listInstances(tenantId: string): Promise<readonly ConnectorInstance[]> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<InstanceRow>({
					text: LIST_INSTANCES,
					parameters: [tenantId],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map((row) => withoutCredential(fromInstanceRow(row)));
	}

	async findInstance(
		tenantId: string,
		id: string,
	): Promise<StoredConnectorInstance | null> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<InstanceRow>({
					text: FIND_INSTANCE,
					parameters: [tenantId, id],
				}),
			{ access: 'read', tenantId },
		);
		const row = result.rows[0];
		return row ? fromInstanceRow(row) : null;
	}

	async createInstance(
		record: StoredConnectorInstance,
		audit: PendingConnectorAuditEvent,
	): Promise<ConnectorInstance> {
		try {
			await this.database.transaction(
				async (transaction) => {
					await transaction.execute({
						text: INSERT_INSTANCE,
						parameters: [
							record.id,
							record.tenantId,
							record.definitionKey,
							record.name,
							normalizedInstanceName(record.name),
							record.baseUrl,
							record.authKind,
							record.credential?.keyId ?? null,
							record.credential?.iv ?? null,
							record.credential?.tag ?? null,
							record.credential?.ciphertext ?? null,
							record.credentialFingerprint,
							JSON.stringify(record.allowedHosts),
							record.allowWorkflows ? 1 : 0,
							record.allowAgents ? 1 : 0,
							record.status,
							record.lastCallAt,
							record.createdAt,
							record.updatedAt,
						],
					});
					await transaction.execute({
						text: INSERT_AUDIT,
						parameters: auditParameters(audit),
					});
				},
				{ access: 'write', tenantId: record.tenantId },
			);
		} catch (error) {
			if (isDuplicateName(error)) throw new DuplicateConnectorNameError();
			throw error;
		}
		return withoutCredential(record);
	}

	async updateInstance(
		record: StoredConnectorInstance,
		audit: PendingConnectorAuditEvent,
	): Promise<ConnectorInstance> {
		try {
			await this.database.transaction(
				async (transaction) => {
					await transaction.execute({
						text: UPDATE_INSTANCE,
						parameters: [
							record.tenantId,
							record.id,
							record.name,
							normalizedInstanceName(record.name),
							record.baseUrl,
							record.credential?.keyId ?? null,
							record.credential?.iv ?? null,
							record.credential?.tag ?? null,
							record.credential?.ciphertext ?? null,
							record.credentialFingerprint,
							JSON.stringify(record.allowedHosts),
							record.updatedAt,
						],
					});
					await transaction.execute({
						text: INSERT_AUDIT,
						parameters: auditParameters(audit),
					});
				},
				{ access: 'write', tenantId: record.tenantId },
			);
		} catch (error) {
			if (isDuplicateName(error)) throw new DuplicateConnectorNameError();
			throw error;
		}
		return withoutCredential(record);
	}

	async setConsent(
		tenantId: string,
		id: string,
		consent: {
			readonly allowWorkflows: boolean;
			readonly allowAgents: boolean;
			readonly updatedAt: number;
		},
		audit: PendingConnectorAuditEvent,
	): Promise<ConnectorInstance | null> {
		return this.database.transaction(
			async (transaction) => {
				const updated = await transaction.execute({
					text: SET_CONSENT,
					parameters: [
						tenantId,
						id,
						consent.allowWorkflows ? 1 : 0,
						consent.allowAgents ? 1 : 0,
						consent.updatedAt,
					],
				});
				if (updated.affectedRows === 0) return null;
				await transaction.execute({
					text: INSERT_AUDIT,
					parameters: auditParameters(audit),
				});
				const result = await transaction.query<InstanceRow>({
					text: FIND_INSTANCE,
					parameters: [tenantId, id],
				});
				const row = result.rows[0];
				return row ? withoutCredential(fromInstanceRow(row)) : null;
			},
			{ access: 'write', tenantId },
		);
	}

	async setStatus(
		tenantId: string,
		id: string,
		status: ConnectorInstanceStatus,
		updatedAt: number,
		audit: PendingConnectorAuditEvent,
	): Promise<ConnectorInstance | null> {
		return this.database.transaction(
			async (transaction) => {
				const updated = await transaction.execute({
					text: SET_STATUS,
					parameters: [tenantId, id, status, updatedAt],
				});
				if (updated.affectedRows === 0) return null;
				await transaction.execute({
					text: INSERT_AUDIT,
					parameters: auditParameters(audit),
				});
				const result = await transaction.query<InstanceRow>({
					text: FIND_INSTANCE,
					parameters: [tenantId, id],
				});
				const row = result.rows[0];
				return row ? withoutCredential(fromInstanceRow(row)) : null;
			},
			{ access: 'write', tenantId },
		);
	}

	async deleteInstance(
		tenantId: string,
		id: string,
		audit: PendingConnectorAuditEvent,
	): Promise<boolean> {
		return this.database.transaction(
			async (transaction) => {
				const removed = await transaction.execute({
					text: DELETE_DISABLED_INSTANCE,
					parameters: [tenantId, id],
				});
				if (removed.affectedRows === 0) return false;
				await transaction.execute({
					text: INSERT_AUDIT,
					parameters: auditParameters(audit),
				});
				return true;
			},
			{ access: 'write', tenantId },
		);
	}

	async claimCallKey(
		tenantId: string,
		key: string,
		claim: ConnectorCallKeyClaim,
	): Promise<ConnectorCallKeyDecision> {
		try {
			return await this.#claimCallKey(tenantId, key, claim);
		} catch (error) {
			if (!isDuplicateCallKey(error)) throw error;
			/* Another attempt inserted the same key between the read and the
			   write, so the row it wrote is what this one has to answer from. */
			return this.#claimCallKey(tenantId, key, claim);
		}
	}

	async findCall(tenantId: string, id: string): Promise<ConnectorCall | null> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<CallRow>({
					text: FIND_CALL,
					parameters: [tenantId, id],
				}),
			{ access: 'read', tenantId },
		);
		const row = result.rows[0];
		return row ? fromCallRow(row) : null;
	}

	async recordCall(
		call: ConnectorCall,
		idempotencyKey: string | null,
	): Promise<void> {
		await this.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: INSERT_CALL,
					parameters: [
						call.id,
						call.tenantId,
						call.instanceId,
						call.operation,
						call.caller,
						call.callerRef,
						call.outcome,
						call.status,
						call.errorClass,
						call.durationMs,
						call.requestBytes,
						call.responseBytes,
						call.occurredAt,
					],
				});
				await transaction.execute({
					text: TOUCH_LAST_CALL,
					parameters: [call.tenantId, call.instanceId, call.occurredAt],
				});
				if (idempotencyKey !== null) {
					await transaction.execute({
						text: BIND_CALL_KEY,
						parameters: [
							call.tenantId,
							idempotencyKey,
							call.id,
							call.occurredAt,
						],
					});
				}
			},
			{ access: 'write', tenantId: call.tenantId },
		);
	}

	async deleteCallsBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number> {
		return this.database.transaction(
			async (transaction) => {
				const calls = await transaction.execute({
					text: DELETE_CALLS_BEFORE,
					parameters: [tenantId, before, limit],
				});
				const budget = limit - calls.affectedRows;
				if (budget <= 0) return calls.affectedRows;
				const keys = await transaction.execute({
					text: DELETE_CALL_KEYS_BEFORE,
					parameters: [tenantId, before, budget],
				});
				return calls.affectedRows + keys.affectedRows;
			},
			{ access: 'write', tenantId },
		);
	}

	async exportCallsPage(
		tenantId: string,
		after: ConnectorExportCursor | null,
		limit: number,
	): Promise<readonly ConnectorCall[]> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<CallRow>({
					text: EXPORT_CALLS,
					parameters: [
						tenantId,
						after?.occurredAt ?? 0,
						after?.id ?? '',
						limit,
					],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromCallRow);
	}

	async exportAuditPage(
		tenantId: string,
		after: ConnectorExportCursor | null,
		limit: number,
	): Promise<readonly ConnectorAuditEvent[]> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<AuditRow>({
					text: EXPORT_AUDIT,
					parameters: [
						tenantId,
						after?.occurredAt ?? 0,
						after?.id ?? '',
						limit,
					],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromAuditRow);
	}

	async exportInstancesPage(
		tenantId: string,
		after: ConnectorExportCursor | null,
		limit: number,
	): Promise<readonly ConnectorInstance[]> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<InstanceRow>({
					text: EXPORT_INSTANCES,
					parameters: [
						tenantId,
						after?.occurredAt ?? 0,
						after?.id ?? '',
						limit,
					],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map((row) => withoutCredential(fromInstanceRow(row)));
	}

	#claimCallKey(
		tenantId: string,
		key: string,
		claim: ConnectorCallKeyClaim,
	): Promise<ConnectorCallKeyDecision> {
		return this.database.transaction(
			async (transaction) => {
				const found = await transaction.query<CallKeyRow>({
					text: FIND_CALL_KEY,
					parameters: [tenantId, key],
				});
				const row = found.rows[0];
				if (row) {
					if (
						row.operation_id !== claim.operationId ||
						row.input_digest !== claim.inputDigest
					) {
						return { state: 'conflict' };
					}
					if (row.call_id !== null) {
						return { state: 'replay', callId: row.call_id };
					}
					const claimedAt = integer(row.claimed_at, 'timestamp');
					if (claimedAt >= claim.staleBefore) {
						return { state: 'in-flight' };
					}
					const retaken = await transaction.execute({
						text: RETAKE_CALL_KEY,
						parameters: [tenantId, key, claim.claimedAt, claimedAt],
					});
					return retaken.affectedRows === 0
						? { state: 'in-flight' }
						: { state: 'claimed' };
				}
				await transaction.execute({
					text: INSERT_CALL_KEY,
					parameters: [
						randomUUID(),
						tenantId,
						key,
						claim.operationId,
						claim.inputDigest,
						claim.claimedAt,
					],
				});
				return { state: 'claimed' };
			},
			{ access: 'write', tenantId },
		);
	}

	async listCalls(
		tenantId: string,
		filters: ConnectorCallFilters,
		limit: number,
	): Promise<readonly ConnectorCall[]> {
		const parameters: DatabaseParameter[] = [tenantId];
		const predicates = ['tenant_id = $1'];
		if (filters.outcome) {
			parameters.push(filters.outcome);
			predicates.push(`outcome = $${parameters.length}`);
		}
		if (filters.instanceId) {
			parameters.push(filters.instanceId);
			predicates.push(`instance_id = $${parameters.length}`);
		}
		parameters.push(limit);
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<CallRow>({
					text: `SELECT id, tenant_id, instance_id, operation, caller, caller_ref,
					        outcome, status, error_class, duration_ms, request_bytes,
					        response_bytes, occurred_at
					 FROM connectors_calls
					 WHERE ${predicates.join(' AND ')}
					 ORDER BY occurred_at DESC, id DESC
					 LIMIT $${parameters.length}`,
					parameters,
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromCallRow);
	}

	async listAudit(
		tenantId: string,
		instanceId: string,
		limit: number,
	): Promise<readonly ConnectorAuditEvent[]> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<AuditRow>({
					text: LIST_AUDIT,
					parameters: [tenantId, instanceId, limit],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromAuditRow);
	}
}

export async function migrateConnectorsDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'connectors.core', databaseMigrations);
}
