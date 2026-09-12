import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseHandle, DatabaseTransaction } from '@flowdular/database';
import { runDatabaseMigrations } from '@flowdular/database';
import { normalizeActor } from '@flowdular/kernel';
import type { UserActor } from '@flowdular/kernel';
import type {
	AutomationAuditEvent,
	AutomationAuditVerification,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type {
	AutomationScheduleRouting,
	AutomationsRepository,
	AutomationTriggerRecord,
	StoredAutomationSchedule,
	StoredAutomationTrigger,
	StoredAutomationTriggerWithSecret,
} from './repository.ts';
import type { EncryptedSecret } from './secret-vault.ts';

interface ScheduleRow {
	id: string;
	tenant_id: string;
	agent_id: string;
	target_kind: string;
	target_key: string | null;
	configured_by_json: string | null;
	permission_snapshot_json: string;
	label: string;
	input_template: string;
	cadence: string;
	enabled: number | bigint | string;
	disabled_reason: string | null;
	next_run_at: number | bigint | string;
	last_run_at: number | bigint | string | null;
	last_run_id: string | null;
	last_error: string | null;
	created_at: number | bigint | string;
	updated_at: number | bigint | string;
	created_by: string;
}

interface TriggerRow {
	id: string;
	tenant_id: string;
	agent_id: string;
	target_kind: string;
	target_key: string | null;
	configured_by_json: string | null;
	permission_snapshot_json: string;
	label: string;
	secret_key_id: string;
	secret_iv: string;
	secret_tag: string;
	secret_ciphertext: string;
	secret_revision: number | bigint | string;
	enabled: number | bigint | string;
	created_at: number | bigint | string;
	updated_at: number | bigint | string;
	created_by: string;
	last_fired_at: number | bigint | string | null;
	accepted_count: number | bigint | string;
	rejected_count: number | bigint | string;
}

interface AuditRow {
	id: string;
	tenant_id: string;
	sequence: number | bigint | string;
	actor_id: string;
	action: string;
	subject_type: AutomationAuditEvent['subjectType'];
	subject_id: string;
	metadata_json: string;
	occurred_at: number | bigint | string;
	previous_hash: string | null;
	event_hash: string;
}

/* PostgreSQL returns BIGINT as a string. The audit hash covers sequence and
   occurredAt, so a string here would break the chain rather than merely look
   wrong. */
function integer(value: number | bigint | string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error('The automations database returned an invalid integer.');
	}
	return normalized;
}

function optionalInteger(
	value: number | bigint | string | null,
): number | null {
	return value === null ? null : integer(value);
}

function configuredBy(value: string | null, createdBy: string): UserActor {
	try {
		const actor = normalizeActor(JSON.parse(value ?? 'null'));
		if (actor?.kind === 'user') return actor;
	} catch {
		/* Pre-ledger and manually repaired rows retain created_by as the safe
		   authority provenance instead of accepting malformed JSON. */
	}
	return { kind: 'user', id: createdBy, label: createdBy };
}

function permissionSnapshot(value: string): readonly string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (
			!Array.isArray(parsed) ||
			parsed.some((entry) => typeof entry !== 'string')
		)
			return [];
		return [...new Set(parsed)].sort();
	} catch {
		return [];
	}
}

function schedule(row: ScheduleRow): StoredAutomationSchedule {
	const targetKind = row.target_kind || 'agent';
	const targetKey = row.target_key ?? row.agent_id;
	return {
		id: row.id,
		tenantId: row.tenant_id,
		targetKind,
		targetKey,
		agentId: targetKind === 'agent' ? targetKey : '',
		label: row.label,
		inputTemplate: row.input_template,
		cadence: row.cadence,
		enabled: integer(row.enabled) === 1,
		disabledReason: row.disabled_reason,
		nextRunAt: integer(row.next_run_at),
		lastRunAt: optionalInteger(row.last_run_at),
		lastRunId: row.last_run_id,
		lastError: row.last_error,
		createdAt: integer(row.created_at),
		updatedAt: integer(row.updated_at),
		createdBy: row.created_by,
		configuredBy: configuredBy(row.configured_by_json, row.created_by),
		permissionSnapshot: permissionSnapshot(row.permission_snapshot_json),
	};
}

function trigger(row: TriggerRow): StoredAutomationTrigger {
	const targetKind = row.target_kind || 'agent';
	const targetKey = row.target_key ?? row.agent_id;
	return {
		id: row.id,
		tenantId: row.tenant_id,
		targetKind,
		targetKey,
		agentId: targetKind === 'agent' ? targetKey : '',
		label: row.label,
		enabled: integer(row.enabled) === 1,
		secretRevision: integer(row.secret_revision),
		createdAt: integer(row.created_at),
		updatedAt: integer(row.updated_at),
		createdBy: row.created_by,
		lastFiredAt: optionalInteger(row.last_fired_at),
		acceptedCount: integer(row.accepted_count),
		rejectedCount: integer(row.rejected_count),
		configuredBy: configuredBy(row.configured_by_json, row.created_by),
		permissionSnapshot: permissionSnapshot(row.permission_snapshot_json),
	};
}

function encrypted(row: TriggerRow): EncryptedSecret {
	return {
		keyId: row.secret_key_id,
		iv: row.secret_iv,
		tag: row.secret_tag,
		ciphertext: row.secret_ciphertext,
	};
}

function stableMetadata(
	metadata: Readonly<Record<string, string | number | boolean>>,
): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(metadata).sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
	);
}

function auditHash(value: {
	tenantId: string;
	sequence: number | bigint | string;
	actorId: string;
	action: string;
	subjectType: AutomationAuditEvent['subjectType'];
	subjectId: string;
	metadataJson: string;
	occurredAt: number;
	previousHash: string | null;
}): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				value.tenantId,
				value.sequence,
				value.actorId,
				value.action,
				value.subjectType,
				value.subjectId,
				value.metadataJson,
				value.occurredAt,
				value.previousHash,
			]),
		)
		.digest('hex');
}

function audit(row: AuditRow): AutomationAuditEvent {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		sequence: integer(row.sequence),
		actorId: row.actor_id,
		action: row.action,
		subjectType: row.subject_type,
		subjectId: row.subject_id,
		metadata: JSON.parse(row.metadata_json) as Readonly<
			Record<string, string | number | boolean>
		>,
		occurredAt: integer(row.occurred_at),
		previousHash: row.previous_hash,
		eventHash: row.event_hash,
	};
}

const SCHEDULE_INSERT_COLUMNS = `(id, tenant_id, agent_id, target_kind, target_key,
		  configured_by_json, permission_snapshot_json,
		  label, input_template, cadence, enabled,
		  disabled_reason, next_run_at, last_run_at, last_run_id, last_error,
		  created_at, updated_at, created_by)`;

const TRIGGER_INSERT_COLUMNS = `(id, tenant_id, agent_id, target_kind, target_key,
		  configured_by_json, permission_snapshot_json,
		  label, secret_key_id, secret_iv, secret_tag,
		  secret_ciphertext, secret_revision, enabled, created_at, updated_at,
		  created_by, last_fired_at, accepted_count, rejected_count)`;

const AUDIT_INSERT_COLUMNS = `(id, tenant_id, sequence, actor_id, action,
		  subject_type, subject_id, metadata_json, occurred_at,
		  previous_hash, event_hash)`;

function markers(count: number): string {
	return Array.from({ length: count }, (_value, index) => `$${index + 1}`).join(
		', ',
	);
}

const SQL = {
	listSchedules: `SELECT * FROM automations_schedules WHERE tenant_id = $1
	 ORDER BY lower(label), id`,
	getSchedule: `SELECT * FROM automations_schedules
	 WHERE tenant_id = $1 AND id = $2`,
	createSchedule: `INSERT INTO automations_schedules
	 ${SCHEDULE_INSERT_COLUMNS}
	 VALUES (${markers(19)})`,
	updateSchedule: `UPDATE automations_schedules SET agent_id = $1,
	 target_kind = $2, target_key = $3, configured_by_json = $4,
	 permission_snapshot_json = $5, label = $6, input_template = $7,
	 cadence = $8, enabled = $9, disabled_reason = $10,
	 next_run_at = $11, updated_at = $12
	 WHERE tenant_id = $13 AND id = $14`,
	deleteSchedule: `DELETE FROM automations_schedules
	 WHERE tenant_id = $1 AND id = $2`,
	/* Read through the cross-tenant background lease; the write that follows
	   uses the tenant of the row this returned. */
	listDueSchedules: `SELECT tenant_id, id, next_run_at
	 FROM automations_schedules WHERE enabled = 1
	 AND next_run_at <= $1 ORDER BY next_run_at, id LIMIT $2`,
	advanceSchedule: `UPDATE automations_schedules SET next_run_at = $1,
	 last_run_at = $2, last_run_id = $3, last_error = $4,
	 updated_at = $5
	 WHERE tenant_id = $6 AND id = $7 AND enabled = 1
	   AND next_run_at = $8`,
	disableSchedule: `UPDATE automations_schedules SET enabled = 0,
	 disabled_reason = $1, updated_at = $2
	 WHERE tenant_id = $3 AND id = $4 AND enabled = 1`,
	listTriggers: `SELECT * FROM automations_triggers WHERE tenant_id = $1
	 ORDER BY lower(label), id`,
	getTrigger: `SELECT * FROM automations_triggers
	 WHERE tenant_id = $1 AND id = $2`,
	/* Read through the cross-tenant background lease. It routes a webhook to a
	   tenant and nothing more; the trigger itself is read again under that
	   tenant, where the secret and the target actually live. */
	findTriggerTenant: `SELECT tenant_id FROM automations_triggers WHERE id = $1`,
	createTrigger: `INSERT INTO automations_triggers
	 ${TRIGGER_INSERT_COLUMNS}
	 VALUES (${markers(20)})`,
	updateTrigger: `UPDATE automations_triggers SET agent_id = $1,
	 target_kind = $2, target_key = $3, configured_by_json = $4,
	 permission_snapshot_json = $5, label = $6, enabled = $7,
	 updated_at = $8 WHERE tenant_id = $9 AND id = $10`,
	rotateTriggerSecret: `UPDATE automations_triggers SET secret_key_id = $1,
	 secret_iv = $2, secret_tag = $3, secret_ciphertext = $4,
	 secret_revision = secret_revision + 1, updated_at = $5
	 WHERE tenant_id = $6 AND id = $7`,
	deleteTrigger: `DELETE FROM automations_triggers
	 WHERE tenant_id = $1 AND id = $2`,
	recordTriggerOutcome: `UPDATE automations_triggers SET last_fired_at = $1,
	 accepted_count = accepted_count + $2,
	 rejected_count = rejected_count + $3
	 WHERE tenant_id = $4 AND id = $5`,
	latestAudit: `SELECT sequence, event_hash FROM automations_audit_events
	 WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT 1`,
	insertAudit: `INSERT INTO automations_audit_events
	 ${AUDIT_INSERT_COLUMNS}
	 VALUES (${markers(11)})`,
	listAudit: `SELECT * FROM automations_audit_events WHERE tenant_id = $1
	 ORDER BY sequence DESC LIMIT $2`,
	auditChain: `SELECT * FROM automations_audit_events WHERE tenant_id = $1
	 ORDER BY sequence ASC`,
	exportAudit: `SELECT * FROM automations_audit_events
	 WHERE tenant_id = $1 AND id > $2
	 ORDER BY id LIMIT $3`,
} as const;

export async function migrateAutomationsDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'automations.core', databaseMigrations);
}

export interface AutomationsDatabaseHandles {
	/** Tenant-scoped handle used by every request-time read and write. */
	readonly runtime: DatabaseHandle;
	/**
	 * Cross-tenant read handle for the scheduler poll and the webhook lookup.
	 * It reads only what the tables' own FOR SELECT policy grants and writes
	 * nothing; the write that follows uses the tenant of the row it returned.
	 */
	readonly background: DatabaseHandle;
}

/** A repository over platform-owned PostgreSQL handles. */
export class DatabaseAutomationsRepository implements AutomationsRepository {
	constructor(private readonly handles: AutomationsDatabaseHandles) {}

	async listSchedules(
		tenantId: string,
	): Promise<readonly StoredAutomationSchedule[]> {
		const result = await this.#read<ScheduleRow>(tenantId, {
			text: SQL.listSchedules,
			parameters: [tenantId],
		});
		return result.map(schedule);
	}

	async getSchedule(
		tenantId: string,
		scheduleId: string,
	): Promise<StoredAutomationSchedule | null> {
		const rows = await this.#read<ScheduleRow>(tenantId, {
			text: SQL.getSchedule,
			parameters: [tenantId, scheduleId],
		});
		return rows[0] ? schedule(rows[0]) : null;
	}

	async createSchedule(
		record: StoredAutomationSchedule,
	): Promise<StoredAutomationSchedule> {
		await this.#write(record.tenantId, {
			text: SQL.createSchedule,
			parameters: [
				record.id,
				record.tenantId,
				record.agentId,
				record.targetKind,
				record.targetKey,
				JSON.stringify(record.configuredBy),
				JSON.stringify([...new Set(record.permissionSnapshot)].sort()),
				record.label,
				record.inputTemplate,
				record.cadence,
				record.enabled ? 1 : 0,
				record.disabledReason,
				record.nextRunAt,
				record.lastRunAt,
				record.lastRunId,
				record.lastError,
				record.createdAt,
				record.updatedAt,
				record.createdBy,
			],
		});
		return record;
	}

	async updateSchedule(
		record: StoredAutomationSchedule,
	): Promise<StoredAutomationSchedule> {
		const affected = await this.#write(record.tenantId, {
			text: SQL.updateSchedule,
			parameters: [
				record.agentId,
				record.targetKind,
				record.targetKey,
				JSON.stringify(record.configuredBy),
				JSON.stringify([...new Set(record.permissionSnapshot)].sort()),
				record.label,
				record.inputTemplate,
				record.cadence,
				record.enabled ? 1 : 0,
				record.disabledReason,
				record.nextRunAt,
				record.updatedAt,
				record.tenantId,
				record.id,
			],
		});
		if (affected !== 1) throw new Error('Automation schedule not found.');
		return (await this.getSchedule(record.tenantId, record.id))!;
	}

	async deleteSchedule(tenantId: string, scheduleId: string): Promise<boolean> {
		const affected = await this.#write(tenantId, {
			text: SQL.deleteSchedule,
			parameters: [tenantId, scheduleId],
		});
		return affected === 1;
	}

	async listDueSchedules(
		now: number,
		limit: number,
	): Promise<readonly AutomationScheduleRouting[]> {
		const result = await this.handles.background.query<{
			tenant_id: string;
			id: string;
			next_run_at: number | bigint | string;
		}>({
			text: SQL.listDueSchedules,
			parameters: [now, limit],
		});
		return result.rows.map((row) => ({
			tenantId: row.tenant_id,
			id: row.id,
			nextRunAt: integer(row.next_run_at),
		}));
	}

	async advanceSchedule(input: {
		readonly tenantId: string;
		readonly scheduleId: string;
		readonly firedSlot: number;
		readonly nextRunAt: number;
		readonly lastRunAt: number;
		readonly lastRunId: string | null;
		readonly lastError: string | null;
	}): Promise<boolean> {
		const affected = await this.#write(input.tenantId, {
			text: SQL.advanceSchedule,
			parameters: [
				input.nextRunAt,
				input.lastRunAt,
				input.lastRunId,
				input.lastError,
				input.lastRunAt,
				input.tenantId,
				input.scheduleId,
				input.firedSlot,
			],
		});
		return affected === 1;
	}

	async disableSchedule(
		tenantId: string,
		scheduleId: string,
		reason: string,
		now: number,
	): Promise<boolean> {
		const affected = await this.#write(tenantId, {
			text: SQL.disableSchedule,
			parameters: [reason, now, tenantId, scheduleId],
		});
		return affected === 1;
	}

	async listTriggers(
		tenantId: string,
	): Promise<readonly StoredAutomationTrigger[]> {
		const rows = await this.#read<TriggerRow>(tenantId, {
			text: SQL.listTriggers,
			parameters: [tenantId],
		});
		return rows.map(trigger);
	}

	async getTrigger(
		tenantId: string,
		triggerId: string,
	): Promise<StoredAutomationTrigger | null> {
		const rows = await this.#read<TriggerRow>(tenantId, {
			text: SQL.getTrigger,
			parameters: [tenantId, triggerId],
		});
		return rows[0] ? trigger(rows[0]) : null;
	}

	async findTriggerForFire(
		triggerId: string,
	): Promise<StoredAutomationTriggerWithSecret | null> {
		/* A webhook arrives with an identifier and no tenant. The cross-tenant
		   lease may learn only which tenant owns the identifier; the trigger is
		   then read under that tenant, and every later write uses it too. */
		const routing = await this.handles.background.query<{ tenant_id: string }>({
			text: SQL.findTriggerTenant,
			parameters: [triggerId],
		});
		const tenantId = routing.rows[0]?.tenant_id;
		if (tenantId === undefined) return null;
		const rows = await this.#read<TriggerRow>(tenantId, {
			text: SQL.getTrigger,
			parameters: [tenantId, triggerId],
		});
		const row = rows[0];
		return row ? { ...trigger(row), secret: encrypted(row) } : null;
	}

	async createTrigger(
		record: AutomationTriggerRecord,
	): Promise<StoredAutomationTrigger> {
		await this.#write(record.tenantId, {
			text: SQL.createTrigger,
			parameters: [
				record.id,
				record.tenantId,
				record.agentId,
				record.targetKind,
				record.targetKey,
				JSON.stringify(record.configuredBy),
				JSON.stringify([...new Set(record.permissionSnapshot)].sort()),
				record.label,
				record.secret.keyId,
				record.secret.iv,
				record.secret.tag,
				record.secret.ciphertext,
				record.secretRevision,
				record.enabled ? 1 : 0,
				record.createdAt,
				record.updatedAt,
				record.createdBy,
				record.lastFiredAt,
				record.acceptedCount,
				record.rejectedCount,
			],
		});
		return (await this.getTrigger(record.tenantId, record.id))!;
	}

	async updateTrigger(
		record: StoredAutomationTrigger,
	): Promise<StoredAutomationTrigger | null> {
		const affected = await this.#write(record.tenantId, {
			text: SQL.updateTrigger,
			parameters: [
				record.agentId,
				record.targetKind,
				record.targetKey,
				JSON.stringify(record.configuredBy),
				JSON.stringify([...new Set(record.permissionSnapshot)].sort()),
				record.label,
				record.enabled ? 1 : 0,
				record.updatedAt,
				record.tenantId,
				record.id,
			],
		});
		return affected === 1 ? this.getTrigger(record.tenantId, record.id) : null;
	}

	async rotateTriggerSecret(
		tenantId: string,
		triggerId: string,
		secret: EncryptedSecret,
		now: number,
	): Promise<StoredAutomationTrigger | null> {
		const affected = await this.#write(tenantId, {
			text: SQL.rotateTriggerSecret,
			parameters: [
				secret.keyId,
				secret.iv,
				secret.tag,
				secret.ciphertext,
				now,
				tenantId,
				triggerId,
			],
		});
		return affected === 1 ? this.getTrigger(tenantId, triggerId) : null;
	}

	async deleteTrigger(tenantId: string, triggerId: string): Promise<boolean> {
		const affected = await this.#write(tenantId, {
			text: SQL.deleteTrigger,
			parameters: [tenantId, triggerId],
		});
		return affected === 1;
	}

	async recordTriggerOutcome(
		tenantId: string,
		triggerId: string,
		accepted: boolean,
		occurredAt: number,
	): Promise<void> {
		await this.#write(tenantId, {
			text: SQL.recordTriggerOutcome,
			parameters: [
				occurredAt,
				accepted ? 1 : 0,
				accepted ? 0 : 1,
				tenantId,
				triggerId,
			],
		});
	}

	/* The previous hash is read and the next event written inside one
	   transaction, so two writers cannot fork the tenant chain. */
	async appendAuditEvent(
		event: Omit<
			AutomationAuditEvent,
			'id' | 'sequence' | 'previousHash' | 'eventHash'
		>,
	): Promise<AutomationAuditEvent> {
		return this.handles.runtime.transaction(
			async (transaction) => {
				const latest = await transaction.query<{
					sequence: number | bigint | string;
					event_hash: string;
				}>({
					text: SQL.latestAudit,
					parameters: [event.tenantId],
				});
				const previous = latest.rows[0];
				const sequence = (previous ? integer(previous.sequence) : 0) + 1;
				const previousHash = previous?.event_hash ?? null;
				const metadataJson = stableMetadata(event.metadata);
				const created: AutomationAuditEvent = {
					...event,
					id: randomUUID(),
					sequence,
					previousHash,
					eventHash: auditHash({
						tenantId: event.tenantId,
						sequence,
						actorId: event.actorId,
						action: event.action,
						subjectType: event.subjectType,
						subjectId: event.subjectId,
						metadataJson,
						occurredAt: event.occurredAt,
						previousHash,
					}),
				};
				await transaction.execute({
					text: SQL.insertAudit,
					parameters: [
						created.id,
						created.tenantId,
						created.sequence,
						created.actorId,
						created.action,
						created.subjectType,
						created.subjectId,
						metadataJson,
						created.occurredAt,
						created.previousHash,
						created.eventHash,
					],
				});
				return created;
			},
			{ access: 'write', tenantId: event.tenantId },
		);
	}

	async listAuditEvents(
		tenantId: string,
		limit: number,
	): Promise<readonly AutomationAuditEvent[]> {
		const rows = await this.#read<AuditRow>(tenantId, {
			text: SQL.listAudit,
			parameters: [tenantId, limit],
		});
		return rows.map(audit);
	}

	async exportAuditEventsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly AutomationAuditEvent[]> {
		const rows = await this.#read<AuditRow>(tenantId, {
			text: SQL.exportAudit,
			parameters: [tenantId, afterId, limit],
		});
		return rows.map(audit);
	}

	async verifyAuditChain(
		tenantId: string,
	): Promise<AutomationAuditVerification> {
		const rows = await this.#read<AuditRow>(tenantId, {
			text: SQL.auditChain,
			parameters: [tenantId],
		});
		const events = rows.map(audit);
		let previousHash: string | null = null;
		let expectedSequence = 1;
		for (const event of events) {
			const expected = auditHash({
				tenantId: event.tenantId,
				sequence: event.sequence,
				actorId: event.actorId,
				action: event.action,
				subjectType: event.subjectType,
				subjectId: event.subjectId,
				metadataJson: stableMetadata(event.metadata),
				occurredAt: event.occurredAt,
				previousHash: event.previousHash,
			});
			if (
				event.sequence !== expectedSequence ||
				event.previousHash !== previousHash ||
				expected !== event.eventHash
			) {
				return { verified: false, brokenAt: event.id };
			}
			previousHash = event.eventHash;
			expectedSequence += 1;
		}
		return { verified: true, brokenAt: null };
	}

	async #read<Row extends object>(
		tenantId: string,
		statement: { readonly text: string; readonly parameters: unknown[] },
	): Promise<readonly Row[]> {
		const result = await this.handles.runtime.transaction(
			(transaction: DatabaseTransaction) =>
				transaction.query<Row>({
					text: statement.text,
					parameters: statement.parameters as never,
				}),
			{ access: 'read', tenantId },
		);
		return result.rows;
	}

	async #write(
		tenantId: string,
		statement: { readonly text: string; readonly parameters: unknown[] },
	): Promise<number> {
		const result = await this.handles.runtime.transaction(
			(transaction: DatabaseTransaction) =>
				transaction.execute({
					text: statement.text,
					parameters: statement.parameters as never,
				}),
			{ access: 'write', tenantId },
		);
		return result.affectedRows;
	}
}
