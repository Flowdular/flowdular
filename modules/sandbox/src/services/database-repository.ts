import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseHandle, DatabaseTransaction } from '@flowdular/database';
import { runDatabaseMigrations } from '@flowdular/database';
import type {
	SandboxAccessGrant,
	SandboxAuditChainVerification,
	SandboxAuditEvent,
	SandboxAuditPage,
	SandboxGrantCapability,
	SandboxSessionRecord,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
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
	granted_at: number | bigint | string;
	expires_at: number | bigint | string | null;
	revoked_at: number | bigint | string | null;
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
	created_at: number | bigint | string;
	updated_at: number | bigint | string;
	ejected_at: number | bigint | string | null;
	archived_at: number | bigint | string | null;
}

interface AuditRow {
	id: string;
	tenant_id: string;
	sequence: number | bigint | string;
	actor_id: string;
	action: string;
	subject_type: SandboxAuditEvent['subjectType'];
	subject_id: string;
	metadata_json: string;
	occurred_at: number | bigint | string;
	previous_hash: string | null;
	event_hash: string;
}

/* PostgreSQL returns BIGINT as a string. The audit hash covers sequence and
   occurredAt, so a string here would silently break every chain verification
   rather than merely look wrong. */
function integer(value: number | bigint | string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error('The sandbox database returned an invalid integer.');
	}
	return normalized;
}

function optionalInteger(
	value: number | bigint | string | null,
): number | null {
	return value === null ? null : integer(value);
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
		grantedAt: integer(row.granted_at),
		expiresAt: optionalInteger(row.expires_at),
		revokedAt: optionalInteger(row.revoked_at),
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
		createdAt: integer(row.created_at),
		updatedAt: integer(row.updated_at),
		ejectedAt: optionalInteger(row.ejected_at),
		archivedAt: optionalInteger(row.archived_at),
	};
}

function fromAuditRow(row: AuditRow): SandboxAuditEvent {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		sequence: integer(row.sequence),
		actorId: row.actor_id,
		action: row.action,
		subjectType: row.subject_type,
		subjectId: row.subject_id,
		metadata: JSON.parse(row.metadata_json) as SandboxAuditEvent['metadata'],
		occurredAt: integer(row.occurred_at),
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
	sequence: number | bigint | string;
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

/* SQL stays explicit. Nothing is rewritten between placeholder styles, and
   every value travels in the adapter's parameter channel. */
const FIND_GRANT =
	'SELECT * FROM sandbox_access_grants WHERE tenant_id = $1 AND account_id = $2';

const LIST_GRANTS = `SELECT * FROM sandbox_access_grants WHERE tenant_id = $1
		 ORDER BY revoked_at IS NOT NULL, lower(email), account_id`;

const SAVE_GRANT = `INSERT INTO sandbox_access_grants
		 (id, tenant_id, account_id, email, display_name, capabilities_json,
		  note, granted_by, granted_at, expires_at, revoked_at, revoked_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		 ON CONFLICT (tenant_id, account_id) DO UPDATE SET
		   email = excluded.email,
		   display_name = excluded.display_name,
		   capabilities_json = excluded.capabilities_json,
		   note = excluded.note,
		   granted_by = excluded.granted_by,
		   granted_at = excluded.granted_at,
		   expires_at = excluded.expires_at,
		   revoked_at = NULL,
		   revoked_by = NULL`;

const REVOKE_GRANT = `UPDATE sandbox_access_grants SET revoked_at = $1, revoked_by = $2
		 WHERE tenant_id = $3 AND account_id = $4 AND revoked_at IS NULL`;

const FIND_SESSION =
	'SELECT * FROM sandbox_sessions WHERE tenant_id = $1 AND id = $2';

const LIST_SESSIONS = `SELECT * FROM sandbox_sessions WHERE tenant_id = $1
		 ORDER BY updated_at DESC, id LIMIT $2`;

const SAVE_SESSION = `INSERT INTO sandbox_sessions
		 (id, tenant_id, account_id, module_id, title, blueprint, driver,
		  mode, state, created_at, updated_at, ejected_at, archived_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
		 WHERE sandbox_sessions.tenant_id = excluded.tenant_id`;

const LATEST_AUDIT = `SELECT sequence, event_hash FROM sandbox_audit_events
		 WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT 1`;

const INSERT_AUDIT = `INSERT INTO sandbox_audit_events
		 (id, tenant_id, sequence, actor_id, action, subject_type,
		  subject_id, metadata_json, occurred_at, previous_hash, event_hash)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

const LIST_AUDIT = `SELECT * FROM sandbox_audit_events WHERE tenant_id = $1
		 ORDER BY sequence DESC LIMIT $2`;

const PAGE_AUDIT_FIRST = `SELECT * FROM sandbox_audit_events WHERE tenant_id = $1
		 ORDER BY occurred_at DESC, sequence DESC LIMIT $2`;

const PAGE_AUDIT_AFTER = `SELECT * FROM sandbox_audit_events WHERE tenant_id = $1
		 AND (occurred_at < $2 OR (occurred_at = $3 AND sequence < $4))
		 ORDER BY occurred_at DESC, sequence DESC LIMIT $5`;

const AUDIT_CHAIN = `SELECT * FROM sandbox_audit_events WHERE tenant_id = $1
		 ORDER BY sequence ASC`;

export async function migrateSandboxDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'sandbox.core', databaseMigrations);
}

/** A repository over a platform-owned PostgreSQL handle. */
export class DatabaseSandboxRepository implements SandboxRepository {
	constructor(
		private readonly database: DatabaseHandle,
		private readonly readyPromise: Promise<void> = Promise.resolve(),
	) {}

	async findGrant(
		tenantId: string,
		accountId: string,
	): Promise<SandboxAccessGrant | null> {
		await this.readyPromise;
		return this.database.transaction(
			async (transaction) => this.#findGrant(transaction, tenantId, accountId),
			{ access: 'read', tenantId },
		);
	}

	async listGrants(tenantId: string): Promise<readonly SandboxAccessGrant[]> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<GrantRow>({
					text: LIST_GRANTS,
					parameters: [tenantId],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromGrantRow);
	}

	async saveGrant(grant: SandboxAccessGrant): Promise<SandboxAccessGrant> {
		await this.readyPromise;
		return this.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: SAVE_GRANT,
					parameters: [
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
					],
				});
				return (await this.#findGrant(
					transaction,
					grant.tenantId,
					grant.accountId,
				))!;
			},
			{ access: 'write', tenantId: grant.tenantId },
		);
	}

	async revokeGrant(
		tenantId: string,
		accountId: string,
		revokedAt: number,
		revokedBy: string,
	): Promise<SandboxAccessGrant | null> {
		await this.readyPromise;
		return this.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: REVOKE_GRANT,
					parameters: [revokedAt, revokedBy, tenantId, accountId],
				});
				return this.#findGrant(transaction, tenantId, accountId);
			},
			{ access: 'write', tenantId },
		);
	}

	async findSession(
		tenantId: string,
		id: string,
	): Promise<SandboxSessionRecord | null> {
		await this.readyPromise;
		return this.database.transaction(
			(transaction) => this.#findSession(transaction, tenantId, id),
			{ access: 'read', tenantId },
		);
	}

	async listSessions(
		tenantId: string,
		limit: number,
	): Promise<readonly SandboxSessionRecord[]> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<SessionRow>({
					text: LIST_SESSIONS,
					parameters: [tenantId, limit],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromSessionRow);
	}

	async saveSession(
		session: SandboxSessionRecord,
	): Promise<SandboxSessionRecord> {
		await this.readyPromise;
		return this.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: SAVE_SESSION,
					parameters: [
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
					],
				});
				return (await this.#findSession(
					transaction,
					session.tenantId,
					session.id,
				))!;
			},
			{ access: 'write', tenantId: session.tenantId },
		);
	}

	/* The previous hash is read and the next event written inside one
	   transaction, so two writers cannot fork the tenant chain. */
	async appendAuditEvent(event: SandboxAuditDraft): Promise<SandboxAuditEvent> {
		await this.readyPromise;
		return this.database.transaction(
			async (transaction) => {
				const latest = await transaction.query<{
					sequence: number | bigint | string;
					event_hash: string;
				}>({
					text: LATEST_AUDIT,
					parameters: [event.tenantId],
				});
				const previous = latest.rows[0];
				const sequence = (previous ? integer(previous.sequence) : 0) + 1;
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
				await transaction.execute({
					text: INSERT_AUDIT,
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
	): Promise<readonly SandboxAuditEvent[]> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<AuditRow>({
					text: LIST_AUDIT,
					parameters: [tenantId, limit],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromAuditRow);
	}

	async pageAuditEvents(
		tenantId: string,
		cursor: { readonly occurredAt: number; readonly sequence: number } | null,
		limit: number,
	): Promise<SandboxAuditPage> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<AuditRow>(
					cursor
						? {
								text: PAGE_AUDIT_AFTER,
								parameters: [
									tenantId,
									cursor.occurredAt,
									cursor.occurredAt,
									cursor.sequence,
									limit + 1,
								],
							}
						: {
								text: PAGE_AUDIT_FIRST,
								parameters: [tenantId, limit + 1],
							},
				),
			{ access: 'read', tenantId },
		);
		const page = result.rows.slice(0, limit).map(fromAuditRow);
		const last = page[page.length - 1];
		return {
			events: page,
			nextCursor:
				result.rows.length > limit && last
					? `${last.occurredAt}:${last.sequence}`
					: null,
		};
	}

	async verifyAuditChain(tenantId: string): Promise<boolean> {
		return (await this.verifyAuditChainDetailed(tenantId)).verified;
	}

	async verifyAuditChainDetailed(
		tenantId: string,
	): Promise<SandboxAuditChainVerification> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<AuditRow>({
					text: AUDIT_CHAIN,
					parameters: [tenantId],
				}),
			{ access: 'read', tenantId },
		);
		const events = result.rows.map(fromAuditRow);
		let previousHash: string | null = null;
		let expectedSequence = 1;
		for (const event of events) {
			if (event.sequence !== expectedSequence) {
				return { verified: false, brokenAt: event.id };
			}
			if (event.previousHash !== previousHash) {
				return { verified: false, brokenAt: event.id };
			}
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
			if (expected !== event.eventHash) {
				return { verified: false, brokenAt: event.id };
			}
			previousHash = event.eventHash;
			expectedSequence += 1;
		}
		return { verified: true, brokenAt: null };
	}

	async #findGrant(
		transaction: DatabaseTransaction,
		tenantId: string,
		accountId: string,
	): Promise<SandboxAccessGrant | null> {
		const result = await transaction.query<GrantRow>({
			text: FIND_GRANT,
			parameters: [tenantId, accountId],
		});
		const row = result.rows[0];
		return row ? fromGrantRow(row) : null;
	}

	async #findSession(
		transaction: DatabaseTransaction,
		tenantId: string,
		id: string,
	): Promise<SandboxSessionRecord | null> {
		const result = await transaction.query<SessionRow>({
			text: FIND_SESSION,
			parameters: [tenantId, id],
		});
		const row = result.rows[0];
		return row ? fromSessionRow(row) : null;
	}
}
