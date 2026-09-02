import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeActor, runModuleMigrations } from '@coreloom/kernel';
import type { UserActor } from '@coreloom/kernel';
import type {
	AutomationAuditEvent,
	AutomationAuditVerification,
} from '../domain/types.ts';
import { migrations } from './migration.ts';
import type {
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
	enabled: number;
	disabled_reason: string | null;
	next_run_at: number;
	last_run_at: number | null;
	last_run_id: string | null;
	last_error: string | null;
	created_at: number;
	updated_at: number;
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
	secret_revision: number;
	enabled: number;
	created_at: number;
	updated_at: number;
	created_by: string;
	last_fired_at: number | null;
	accepted_count: number;
	rejected_count: number;
}

interface AuditRow {
	id: string;
	tenant_id: string;
	sequence: number;
	actor_id: string;
	action: string;
	subject_type: AutomationAuditEvent['subjectType'];
	subject_id: string;
	metadata_json: string;
	occurred_at: number;
	previous_hash: string | null;
	event_hash: string;
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
		enabled: row.enabled === 1,
		disabledReason: row.disabled_reason,
		nextRunAt: row.next_run_at,
		lastRunAt: row.last_run_at,
		lastRunId: row.last_run_id,
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
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
		enabled: row.enabled === 1,
		secretRevision: row.secret_revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		createdBy: row.created_by,
		lastFiredAt: row.last_fired_at,
		acceptedCount: row.accepted_count,
		rejectedCount: row.rejected_count,
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
	sequence: number;
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
		sequence: row.sequence,
		actorId: row.actor_id,
		action: row.action,
		subjectType: row.subject_type,
		subjectId: row.subject_id,
		metadata: JSON.parse(row.metadata_json) as Readonly<
			Record<string, string | number | boolean>
		>,
		occurredAt: row.occurred_at,
		previousHash: row.previous_hash,
		eventHash: row.event_hash,
	};
}

export class SqliteAutomationsRepository implements AutomationsRepository {
	readonly #database: DatabaseSync;
	#closed = false;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5000 });
		this.#database.exec('PRAGMA journal_mode = WAL;');
		runModuleMigrations(this.#database, migrations);
	}

	listSchedules(tenantId: string): readonly StoredAutomationSchedule[] {
		return (
			this.#database
				.prepare(
					`SELECT * FROM automations_schedules WHERE tenant_id = ?
					 ORDER BY lower(label), id`,
				)
				.all(tenantId) as unknown as ScheduleRow[]
		).map(schedule);
	}

	getSchedule(
		tenantId: string,
		scheduleId: string,
	): StoredAutomationSchedule | null {
		const row = this.#database
			.prepare(
				'SELECT * FROM automations_schedules WHERE tenant_id = ? AND id = ?',
			)
			.get(tenantId, scheduleId) as unknown as ScheduleRow | undefined;
		return row ? schedule(row) : null;
	}

	createSchedule(record: StoredAutomationSchedule): StoredAutomationSchedule {
		this.#database
			.prepare(
				`INSERT INTO automations_schedules
				 (id, tenant_id, agent_id, target_kind, target_key,
				  configured_by_json, permission_snapshot_json,
				  label, input_template, cadence, enabled,
				  disabled_reason, next_run_at, last_run_at, last_run_id, last_error,
				  created_at, updated_at, created_by)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
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
			);
		return record;
	}

	updateSchedule(record: StoredAutomationSchedule): StoredAutomationSchedule {
		const result = this.#database
			.prepare(
				`UPDATE automations_schedules SET agent_id = ?, target_kind = ?,
				 target_key = ?, configured_by_json = ?, permission_snapshot_json = ?,
				 label = ?, input_template = ?, cadence = ?, enabled = ?, disabled_reason = ?,
				 next_run_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
			)
			.run(
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
			);
		if (result.changes !== 1) throw new Error('Automation schedule not found.');
		return this.getSchedule(record.tenantId, record.id)!;
	}

	deleteSchedule(tenantId: string, scheduleId: string): boolean {
		return (
			this.#database
				.prepare(
					'DELETE FROM automations_schedules WHERE tenant_id = ? AND id = ?',
				)
				.run(tenantId, scheduleId).changes === 1
		);
	}

	listDueSchedules(
		now: number,
		limit: number,
	): readonly StoredAutomationSchedule[] {
		return (
			this.#database
				.prepare(
					`SELECT * FROM automations_schedules WHERE enabled = 1
					 AND next_run_at <= ? ORDER BY next_run_at, id LIMIT ?`,
				)
				.all(now, limit) as unknown as ScheduleRow[]
		).map(schedule);
	}

	advanceSchedule(input: {
		readonly tenantId: string;
		readonly scheduleId: string;
		readonly firedSlot: number;
		readonly nextRunAt: number;
		readonly lastRunAt: number;
		readonly lastRunId: string | null;
		readonly lastError: string | null;
	}): boolean {
		return (
			this.#database
				.prepare(
					`UPDATE automations_schedules SET next_run_at = ?, last_run_at = ?,
					 last_run_id = ?, last_error = ?, updated_at = ?
					 WHERE tenant_id = ? AND id = ? AND enabled = 1 AND next_run_at = ?`,
				)
				.run(
					input.nextRunAt,
					input.lastRunAt,
					input.lastRunId,
					input.lastError,
					input.lastRunAt,
					input.tenantId,
					input.scheduleId,
					input.firedSlot,
				).changes === 1
		);
	}

	disableSchedule(
		tenantId: string,
		scheduleId: string,
		reason: string,
		now: number,
	): boolean {
		return (
			this.#database
				.prepare(
					`UPDATE automations_schedules SET enabled = 0, disabled_reason = ?,
					 updated_at = ? WHERE tenant_id = ? AND id = ? AND enabled = 1`,
				)
				.run(reason, now, tenantId, scheduleId).changes === 1
		);
	}

	listTriggers(tenantId: string): readonly StoredAutomationTrigger[] {
		return (
			this.#database
				.prepare(
					`SELECT * FROM automations_triggers WHERE tenant_id = ?
					 ORDER BY lower(label), id`,
				)
				.all(tenantId) as unknown as TriggerRow[]
		).map(trigger);
	}

	getTrigger(
		tenantId: string,
		triggerId: string,
	): StoredAutomationTrigger | null {
		const row = this.#database
			.prepare(
				'SELECT * FROM automations_triggers WHERE tenant_id = ? AND id = ?',
			)
			.get(tenantId, triggerId) as unknown as TriggerRow | undefined;
		return row ? trigger(row) : null;
	}

	findTriggerForFire(
		triggerId: string,
	): StoredAutomationTriggerWithSecret | null {
		const row = this.#database
			.prepare('SELECT * FROM automations_triggers WHERE id = ?')
			.get(triggerId) as unknown as TriggerRow | undefined;
		return row ? { ...trigger(row), secret: encrypted(row) } : null;
	}

	createTrigger(record: AutomationTriggerRecord): StoredAutomationTrigger {
		this.#database
			.prepare(
				`INSERT INTO automations_triggers
				 (id, tenant_id, agent_id, target_kind, target_key,
				  configured_by_json, permission_snapshot_json,
				  label, secret_key_id, secret_iv, secret_tag,
				  secret_ciphertext, secret_revision, enabled, created_at, updated_at,
				  created_by, last_fired_at, accepted_count, rejected_count)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
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
			);
		return this.getTrigger(record.tenantId, record.id)!;
	}

	updateTrigger(
		record: StoredAutomationTrigger,
	): StoredAutomationTrigger | null {
		const result = this.#database
			.prepare(
				`UPDATE automations_triggers SET agent_id = ?, target_kind = ?,
				 target_key = ?, configured_by_json = ?, permission_snapshot_json = ?,
				 label = ?, enabled = ?, updated_at = ?
				 WHERE tenant_id = ? AND id = ?`,
			)
			.run(
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
			);
		return result.changes === 1
			? this.getTrigger(record.tenantId, record.id)
			: null;
	}

	rotateTriggerSecret(
		tenantId: string,
		triggerId: string,
		secret: EncryptedSecret,
		now: number,
	): StoredAutomationTrigger | null {
		const result = this.#database
			.prepare(
				`UPDATE automations_triggers SET secret_key_id = ?, secret_iv = ?,
				 secret_tag = ?, secret_ciphertext = ?,
				 secret_revision = secret_revision + 1, updated_at = ?
				 WHERE tenant_id = ? AND id = ?`,
			)
			.run(
				secret.keyId,
				secret.iv,
				secret.tag,
				secret.ciphertext,
				now,
				tenantId,
				triggerId,
			);
		return result.changes === 1 ? this.getTrigger(tenantId, triggerId) : null;
	}

	deleteTrigger(tenantId: string, triggerId: string): boolean {
		return (
			this.#database
				.prepare(
					'DELETE FROM automations_triggers WHERE tenant_id = ? AND id = ?',
				)
				.run(tenantId, triggerId).changes === 1
		);
	}

	recordTriggerOutcome(
		triggerId: string,
		accepted: boolean,
		occurredAt: number,
	): void {
		this.#database
			.prepare(
				`UPDATE automations_triggers SET last_fired_at = ?,
				 accepted_count = accepted_count + ?,
				 rejected_count = rejected_count + ? WHERE id = ?`,
			)
			.run(occurredAt, accepted ? 1 : 0, accepted ? 0 : 1, triggerId);
	}

	appendAuditEvent(
		event: Omit<
			AutomationAuditEvent,
			'id' | 'sequence' | 'previousHash' | 'eventHash'
		>,
	): AutomationAuditEvent {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const previous = this.#database
				.prepare(
					`SELECT sequence, event_hash FROM automations_audit_events
					 WHERE tenant_id = ? ORDER BY sequence DESC LIMIT 1`,
				)
				.get(event.tenantId) as unknown as
				| { sequence: number; event_hash: string }
				| undefined;
			const sequence = (previous?.sequence ?? 0) + 1;
			const previousHash = previous?.event_hash ?? null;
			const metadataJson = stableMetadata(event.metadata);
			const eventHash = auditHash({
				...event,
				sequence,
				metadataJson,
				previousHash,
			});
			const created: AutomationAuditEvent = {
				...event,
				id: randomUUID(),
				sequence,
				previousHash,
				eventHash,
			};
			this.#database
				.prepare(
					`INSERT INTO automations_audit_events
					 (id, tenant_id, sequence, actor_id, action, subject_type,
					  subject_id, metadata_json, occurred_at, previous_hash, event_hash)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
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
				);
			this.#database.exec('COMMIT');
			return created;
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	listAuditEvents(
		tenantId: string,
		limit: number,
	): readonly AutomationAuditEvent[] {
		return (
			this.#database
				.prepare(
					`SELECT * FROM automations_audit_events WHERE tenant_id = ?
					 ORDER BY sequence DESC LIMIT ?`,
				)
				.all(tenantId, limit) as unknown as AuditRow[]
		).map(audit);
	}

	verifyAuditChain(tenantId: string): AutomationAuditVerification {
		const events = (
			this.#database
				.prepare(
					`SELECT * FROM automations_audit_events WHERE tenant_id = ?
					 ORDER BY sequence`,
				)
				.all(tenantId) as unknown as AuditRow[]
		).map(audit);
		let previousHash: string | null = null;
		for (const event of events) {
			if (event.previousHash !== previousHash) {
				return { verified: false, brokenAt: event.id };
			}
			const expected = auditHash({
				...event,
				metadataJson: stableMetadata(event.metadata),
				previousHash,
			});
			if (expected !== event.eventHash) {
				return { verified: false, brokenAt: event.id };
			}
			previousHash = event.eventHash;
		}
		return { verified: true, brokenAt: null };
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#database.close();
	}
}
