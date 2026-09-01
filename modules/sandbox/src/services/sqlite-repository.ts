import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
	SandboxAccessGrant,
	SandboxAuditEvent,
	SandboxGrantCapability,
	SandboxSessionRecord,
} from '../domain/types.ts';
import { SANDBOX_MIGRATION_001, SANDBOX_MIGRATION_002 } from './migration.ts';
import type { SandboxAuditDraft, SandboxRepository } from './repository.ts';

interface GrantRow {
	id: string;
	tenant_id: string;
	account_id: string;
	email: string;
	display_name: string;
	capabilities_json: string;
	note: string | null;
	granted_by: string;
	granted_at: number;
	expires_at: number | null;
	revoked_at: number | null;
	revoked_by: string | null;
}

interface SessionRow {
	id: string;
	tenant_id: string;
	account_id: string;
	module_id: string;
	title: string;
	blueprint: string;
	driver: string;
	mode: SandboxSessionRecord['mode'];
	state: SandboxSessionRecord['state'];
	created_at: number;
	updated_at: number;
	ejected_at: number | null;
	archived_at: number | null;
}

interface AuditRow {
	id: string;
	tenant_id: string;
	sequence: number;
	actor_id: string;
	action: string;
	subject_type: SandboxAuditEvent['subjectType'];
	subject_id: string;
	metadata_json: string;
	occurred_at: number;
	previous_hash: string | null;
	event_hash: string;
}

function fromGrantRow(row: GrantRow): SandboxAccessGrant {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		accountId: row.account_id,
		email: row.email,
		displayName: row.display_name,
		capabilities: JSON.parse(
			row.capabilities_json,
		) as readonly SandboxGrantCapability[],
		note: row.note,
		grantedBy: row.granted_by,
		grantedAt: row.granted_at,
		expiresAt: row.expires_at,
		revokedAt: row.revoked_at,
		revokedBy: row.revoked_by,
	};
}

function fromSessionRow(row: SessionRow): SandboxSessionRecord {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		accountId: row.account_id,
		moduleId: row.module_id,
		title: row.title,
		blueprint: row.blueprint,
		driver: row.driver,
		mode: row.mode,
		state: row.state,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		ejectedAt: row.ejected_at,
		archivedAt: row.archived_at,
	};
}

function fromAuditRow(row: AuditRow): SandboxAuditEvent {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		sequence: row.sequence,
		actorId: row.actor_id,
		action: row.action,
		subjectType: row.subject_type,
		subjectId: row.subject_id,
		metadata: JSON.parse(row.metadata_json) as SandboxAuditEvent['metadata'],
		occurredAt: row.occurred_at,
		previousHash: row.previous_hash,
		eventHash: row.event_hash,
	};
}

function stableMetadata(metadata: SandboxAuditEvent['metadata']): string {
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
	subjectType: SandboxAuditEvent['subjectType'];
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
			'utf8',
		)
		.digest('base64url');
}

export class SqliteSandboxRepository implements SandboxRepository {
	readonly #database: DatabaseSync;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5000 });
		this.#database.exec('PRAGMA journal_mode = WAL;');
		this.#database.exec(SANDBOX_MIGRATION_001);
		const columns = this.#database
			.prepare('PRAGMA table_info(sandbox_sessions)')
			.all() as unknown as readonly { name: string }[];
		if (!columns.some((column) => column.name === 'archived_at')) {
			this.#database.exec(SANDBOX_MIGRATION_002);
		}
	}

	findGrant(tenantId: string, accountId: string): SandboxAccessGrant | null {
		const row = this.#database
			.prepare(
				'SELECT * FROM sandbox_access_grants WHERE tenant_id = ? AND account_id = ?',
			)
			.get(tenantId, accountId) as unknown as GrantRow | undefined;
		return row ? fromGrantRow(row) : null;
	}

	listGrants(tenantId: string): readonly SandboxAccessGrant[] {
		return (
			this.#database
				.prepare(
					`SELECT * FROM sandbox_access_grants WHERE tenant_id = ?
					 ORDER BY revoked_at IS NOT NULL, lower(email), account_id`,
				)
				.all(tenantId) as unknown as GrantRow[]
		).map(fromGrantRow);
	}

	saveGrant(grant: SandboxAccessGrant): SandboxAccessGrant {
		this.#database
			.prepare(
				`INSERT INTO sandbox_access_grants
				 (id, tenant_id, account_id, email, display_name, capabilities_json,
				  note, granted_by, granted_at, expires_at, revoked_at, revoked_by)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (tenant_id, account_id) DO UPDATE SET
				   email = excluded.email,
				   display_name = excluded.display_name,
				   capabilities_json = excluded.capabilities_json,
				   note = excluded.note,
				   granted_by = excluded.granted_by,
				   granted_at = excluded.granted_at,
				   expires_at = excluded.expires_at,
				   revoked_at = NULL,
				   revoked_by = NULL`,
			)
			.run(
				grant.id,
				grant.tenantId,
				grant.accountId,
				grant.email,
				grant.displayName,
				JSON.stringify(grant.capabilities),
				grant.note,
				grant.grantedBy,
				grant.grantedAt,
				grant.expiresAt,
				grant.revokedAt,
				grant.revokedBy,
			);
		return this.findGrant(grant.tenantId, grant.accountId)!;
	}

	revokeGrant(
		tenantId: string,
		accountId: string,
		revokedAt: number,
		revokedBy: string,
	): SandboxAccessGrant | null {
		this.#database
			.prepare(
				`UPDATE sandbox_access_grants SET revoked_at = ?, revoked_by = ?
				 WHERE tenant_id = ? AND account_id = ? AND revoked_at IS NULL`,
			)
			.run(revokedAt, revokedBy, tenantId, accountId);
		return this.findGrant(tenantId, accountId);
	}

	findSession(tenantId: string, id: string): SandboxSessionRecord | null {
		const row = this.#database
			.prepare('SELECT * FROM sandbox_sessions WHERE tenant_id = ? AND id = ?')
			.get(tenantId, id) as unknown as SessionRow | undefined;
		return row ? fromSessionRow(row) : null;
	}

	listSessions(
		tenantId: string,
		limit: number,
	): readonly SandboxSessionRecord[] {
		return (
			this.#database
				.prepare(
					`SELECT * FROM sandbox_sessions WHERE tenant_id = ?
					 ORDER BY updated_at DESC, id LIMIT ?`,
				)
				.all(tenantId, limit) as unknown as SessionRow[]
		).map(fromSessionRow);
	}

	saveSession(session: SandboxSessionRecord): SandboxSessionRecord {
		this.#database
			.prepare(
				`INSERT INTO sandbox_sessions
				 (id, tenant_id, account_id, module_id, title, blueprint, driver,
				  mode, state, created_at, updated_at, ejected_at, archived_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (id) DO UPDATE SET
				   module_id = excluded.module_id,
				   title = excluded.title,
				   blueprint = excluded.blueprint,
				   driver = excluded.driver,
				   mode = excluded.mode,
				   state = excluded.state,
				   updated_at = excluded.updated_at,
				   ejected_at = excluded.ejected_at,
				   archived_at = excluded.archived_at
				 WHERE sandbox_sessions.tenant_id = excluded.tenant_id`,
			)
			.run(
				session.id,
				session.tenantId,
				session.accountId,
				session.moduleId,
				session.title,
				session.blueprint,
				session.driver,
				session.mode,
				session.state,
				session.createdAt,
				session.updatedAt,
				session.ejectedAt,
				session.archivedAt,
			);
		return this.findSession(session.tenantId, session.id)!;
	}

	appendAuditEvent(event: SandboxAuditDraft): SandboxAuditEvent {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const previous = this.#database
				.prepare(
					`SELECT sequence, event_hash FROM sandbox_audit_events
					 WHERE tenant_id = ? ORDER BY sequence DESC LIMIT 1`,
				)
				.get(event.tenantId) as unknown as
				| { sequence: number; event_hash: string }
				| undefined;
			const sequence = (previous?.sequence ?? 0) + 1;
			const previousHash = previous?.event_hash ?? null;
			const metadataJson = stableMetadata(event.metadata);
			const created: SandboxAuditEvent = {
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
			this.#database
				.prepare(
					`INSERT INTO sandbox_audit_events
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
	): readonly SandboxAuditEvent[] {
		return (
			this.#database
				.prepare(
					`SELECT * FROM sandbox_audit_events WHERE tenant_id = ?
					 ORDER BY sequence DESC LIMIT ?`,
				)
				.all(tenantId, limit) as unknown as AuditRow[]
		).map(fromAuditRow);
	}

	verifyAuditChain(tenantId: string): boolean {
		const events = (
			this.#database
				.prepare(
					`SELECT * FROM sandbox_audit_events WHERE tenant_id = ?
					 ORDER BY sequence ASC`,
				)
				.all(tenantId) as unknown as AuditRow[]
		).map(fromAuditRow);
		let previousHash: string | null = null;
		let expectedSequence = 1;
		for (const event of events) {
			if (event.sequence !== expectedSequence) return false;
			if (event.previousHash !== previousHash) return false;
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
			if (expected !== event.eventHash) return false;
			previousHash = event.eventHash;
			expectedSequence += 1;
		}
		return true;
	}

	close(): void {
		this.#database.close();
	}
}
