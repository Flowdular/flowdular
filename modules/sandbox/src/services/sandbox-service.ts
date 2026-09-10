import { randomUUID } from 'node:crypto';
import {
	SANDBOX_GRANT_CAPABILITIES,
	SANDBOX_PERMISSIONS,
} from '../acl/permissions.ts';
import {
	SANDBOX_SESSION_STATES,
	type SandboxAccessCandidate,
	type SandboxAccessGrant,
	type SandboxAuditChainVerification,
	type SandboxAuditEvent,
	type SandboxAuditPage,
	type SandboxAuthority,
	type SandboxGrantCapability,
	type SandboxRuntimeMode,
	type SandboxSessionRecord,
	type SandboxSessionState,
} from '../domain/types.ts';
import type { SandboxDirectory } from './directory.ts';
import type { SandboxRepository } from './repository.ts';
import { SandboxServiceError } from './sandbox-service-error.ts';

const MAX_GRANT_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_NOTE_LENGTH = 280;
const SESSION_LIST_LIMIT = 200;
const DEFAULT_AUDIT_PAGE = 50;
const MAX_AUDIT_PAGE = 200;

/* `occurredAt:sequence` of the last row of the previous page. Both halves are
   non-negative integers; anything else is a client error, never a silent
   first-page fallback. */
function auditCursor(
	raw: string | null,
): { readonly occurredAt: number; readonly sequence: number } | null {
	if (raw === null || raw === '') return null;
	const match = /^(\d+):(\d+)$/.exec(raw);
	const occurredAt = match ? Number(match[1]) : NaN;
	const sequence = match ? Number(match[2]) : NaN;
	if (!Number.isSafeInteger(occurredAt) || !Number.isSafeInteger(sequence)) {
		throw new SandboxServiceError(
			'INVALID_CURSOR',
			'cursor is malformed.',
			400,
		);
	}
	return { occurredAt, sequence };
}

export interface GrantSandboxAccessInput {
	readonly tenantId: string;
	readonly actorId: string;
	readonly accountId: string;
	readonly capabilities?: readonly string[] | undefined;
	readonly expiresAt?: number | null | undefined;
	readonly note?: string | null | undefined;
}

export interface RegisterSandboxSessionInput {
	readonly tenantId: string;
	readonly accountId: string;
	readonly sessionId: string;
	readonly moduleId: string;
	readonly title: string;
	readonly blueprint: string;
	readonly driver: string;
	readonly mode: SandboxRuntimeMode;
}

export interface SandboxServiceOptions {
	readonly now?: () => number;
}

function identifier(value: string, field: string): string {
	const normalized = value.trim();
	if (normalized.length < 1 || normalized.length > 128) {
		throw new SandboxServiceError(
			'INVALID_INPUT',
			`${field} must contain between 1 and 128 characters.`,
			400,
		);
	}
	return normalized;
}

function moduleIdentifier(value: string): string {
	const normalized = value.trim();
	if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(normalized)) {
		throw new SandboxServiceError(
			'INVALID_MODULE_ID',
			'Module id must use lowercase dot-separated segments.',
			400,
		);
	}
	return normalized;
}

function boundedText(
	value: string,
	field: string,
	minimum: number,
	maximum: number,
): string {
	const normalized = value.trim();
	if (normalized.length < minimum || normalized.length > maximum) {
		throw new SandboxServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} characters.`,
			400,
		);
	}
	return normalized;
}

function sessionState(value: string): SandboxSessionState {
	if (!(SANDBOX_SESSION_STATES as readonly string[]).includes(value)) {
		throw new SandboxServiceError(
			'INVALID_SESSION_STATE',
			`${value} is not a sandbox session state.`,
			400,
		);
	}
	return value as SandboxSessionState;
}

function isGrantCapability(value: string): value is SandboxGrantCapability {
	return (SANDBOX_GRANT_CAPABILITIES as readonly string[]).includes(value);
}

function sandboxCapabilitiesOf(
	scopes: readonly string[],
): readonly SandboxGrantCapability[] {
	const held = new Set(scopes);
	return SANDBOX_GRANT_CAPABILITIES.filter((capability) =>
		held.has(capability),
	) as readonly SandboxGrantCapability[];
}

export class SandboxService {
	readonly #now: () => number;

	constructor(
		private readonly repository: SandboxRepository,
		private readonly directory: SandboxDirectory,
		options: SandboxServiceOptions = {},
	) {
		this.#now = options.now ?? Date.now;
	}

	async listCandidates(
		tenantId: string,
	): Promise<readonly SandboxAccessCandidate[]> {
		const tenant = identifier(tenantId, 'tenantId');
		const members = await this.directory.listMembers(tenant);
		return await Promise.all(
			members.map(async (member) => ({
				accountId: member.accountId,
				email: member.email,
				displayName: member.displayName,
				role: member.role,
				status: member.status,
				availableCapabilities: sandboxCapabilitiesOf(
					await this.directory.listScopes(member.accountId, tenant),
				),
			})),
		);
	}

	async listGrants(tenantId: string): Promise<readonly SandboxAccessGrant[]> {
		return await this.repository.listGrants(identifier(tenantId, 'tenantId'));
	}

	async grant(input: GrantSandboxAccessInput): Promise<SandboxAccessGrant> {
		const tenantId = identifier(input.tenantId, 'tenantId');
		const actorId = identifier(input.actorId, 'actorId');
		const accountId = identifier(input.accountId, 'accountId');
		const member = (await this.directory.listMembers(tenantId)).find(
			(candidate) => candidate.accountId === accountId,
		);
		if (!member) {
			throw new SandboxServiceError(
				'ACCOUNT_NOT_FOUND',
				'The account is not a member of this tenant.',
				404,
			);
		}
		if (member.status !== 'active') {
			throw new SandboxServiceError(
				'ACCOUNT_DISABLED',
				'A disabled account cannot receive sandbox access.',
				409,
			);
		}
		const available = new Set(
			sandboxCapabilitiesOf(
				await this.directory.listScopes(accountId, tenantId),
			),
		);
		const requested = input.capabilities ?? [...available];
		for (const capability of requested) {
			if (!isGrantCapability(capability)) {
				throw new SandboxServiceError(
					'UNKNOWN_CAPABILITY',
					`Capability ${capability} is not a sandbox grant capability.`,
					400,
				);
			}
		}
		const capabilities = SANDBOX_GRANT_CAPABILITIES.filter(
			(capability) =>
				available.has(capability) &&
				(requested as readonly string[]).includes(capability),
		) as readonly SandboxGrantCapability[];
		if (!capabilities.includes(SANDBOX_PERMISSIONS.use)) {
			throw new SandboxServiceError(
				'ACCESS_CAPABILITY_REQUIRED',
				'A sandbox grant must include sandbox.access.use, and the account must hold that scope.',
				409,
			);
		}
		const grantedAt = this.#now();
		const expiresAt = this.#expiry(input.expiresAt ?? null, grantedAt);
		const note =
			input.note === undefined || input.note === null || input.note === ''
				? null
				: boundedText(input.note, 'note', 1, MAX_NOTE_LENGTH);
		const existing = await this.repository.findGrant(tenantId, accountId);
		const saved = await this.repository.saveGrant({
			id: existing?.id ?? randomUUID(),
			tenantId,
			accountId,
			email: member.email,
			displayName: member.displayName,
			capabilities,
			note,
			grantedBy: actorId,
			grantedAt,
			expiresAt,
			revokedAt: null,
			revokedBy: null,
		});
		await this.repository.appendAuditEvent({
			tenantId,
			actorId,
			action: 'sandbox.access.granted',
			subjectType: 'grant',
			subjectId: saved.id,
			metadata: {
				accountId,
				capabilities: capabilities.join(' '),
				expiresAt: expiresAt ?? 0,
				renewed: existing !== null,
			},
			occurredAt: grantedAt,
		});
		return saved;
	}

	async revoke(
		tenantId: string,
		accountId: string,
		actorId: string,
	): Promise<SandboxAccessGrant> {
		const tenant = identifier(tenantId, 'tenantId');
		const account = identifier(accountId, 'accountId');
		const actor = identifier(actorId, 'actorId');
		const existing = await this.repository.findGrant(tenant, account);
		if (!existing) {
			throw new SandboxServiceError(
				'GRANT_NOT_FOUND',
				'No sandbox grant exists for this account.',
				404,
			);
		}
		if (existing.revokedAt !== null) return existing;
		const revokedAt = this.#now();
		const revoked = (await this.repository.revokeGrant(
			tenant,
			account,
			revokedAt,
			actor,
		))!;
		await this.repository.appendAuditEvent({
			tenantId: tenant,
			actorId: actor,
			action: 'sandbox.access.revoked',
			subjectType: 'grant',
			subjectId: revoked.id,
			metadata: { accountId: account },
			occurredAt: revokedAt,
		});
		return revoked;
	}

	/* Live platform scopes always win. A grant can narrow authority and can
	   never widen it beyond the scopes the membership holds right now. */
	async authorize(
		tenantId: string,
		accountId: string,
		scopes: readonly string[],
	): Promise<SandboxAuthority> {
		const tenant = identifier(tenantId, 'tenantId');
		const account = identifier(accountId, 'accountId');
		const grant = await this.repository.findGrant(tenant, account);
		if (!grant) return { granted: false, reason: 'grant-missing' };
		if (grant.revokedAt !== null) {
			return { granted: false, reason: 'grant-revoked' };
		}
		if (grant.expiresAt !== null && grant.expiresAt <= this.#now()) {
			return { granted: false, reason: 'grant-expired' };
		}
		const held = new Set(scopes);
		const capabilities = grant.capabilities.filter((capability) =>
			held.has(capability),
		);
		if (!capabilities.includes(SANDBOX_PERMISSIONS.use)) {
			return { granted: false, reason: 'scope-missing' };
		}
		return {
			granted: true,
			grantId: grant.id,
			tenantId: tenant,
			accountId: account,
			capabilities,
			expiresAt: grant.expiresAt,
		};
	}

	async registerSession(
		input: RegisterSandboxSessionInput,
	): Promise<SandboxSessionRecord> {
		const tenantId = identifier(input.tenantId, 'tenantId');
		const accountId = identifier(input.accountId, 'accountId');
		const id = identifier(input.sessionId, 'sessionId');
		const now = this.#now();
		const existing = await this.repository.findSession(tenantId, id);
		const session = await this.repository.saveSession({
			id,
			tenantId,
			accountId,
			moduleId: moduleIdentifier(input.moduleId),
			title: boundedText(input.title, 'title', 2, 120),
			blueprint: boundedText(input.blueprint, 'blueprint', 2, 120),
			driver: boundedText(input.driver, 'driver', 2, 64),
			mode: input.mode,
			state: existing?.state ?? 'draft',
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			ejectedAt: existing?.ejectedAt ?? null,
			archivedAt: existing?.archivedAt ?? null,
		});
		await this.repository.appendAuditEvent({
			tenantId,
			actorId: accountId,
			action: existing ? 'sandbox.session.updated' : 'sandbox.session.opened',
			subjectType: 'session',
			subjectId: session.id,
			metadata: {
				moduleId: session.moduleId,
				driver: session.driver,
				mode: session.mode,
			},
			occurredAt: now,
		});
		return session;
	}

	/* Archiving and deleting are transitions like any other, so the sandbox
	   reports them through the same call; the audit action names them. A
	   transition out of archived is a restore. */
	async updateSessionState(
		tenantId: string,
		sessionId: string,
		requested: SandboxSessionState,
		actorId: string,
	): Promise<SandboxSessionRecord> {
		const tenant = identifier(tenantId, 'tenantId');
		const id = identifier(sessionId, 'sessionId');
		const actor = identifier(actorId, 'actorId');
		const state = sessionState(requested);
		const existing = await this.repository.findSession(tenant, id);
		if (!existing) {
			throw new SandboxServiceError(
				'SESSION_NOT_FOUND',
				'The sandbox session does not exist in this tenant.',
				404,
			);
		}
		if (existing.state === 'deleted') {
			throw new SandboxServiceError(
				'SESSION_DELETED',
				'A deleted sandbox session cannot change state.',
				409,
			);
		}
		const now = this.#now();
		const session = await this.repository.saveSession({
			...existing,
			state,
			updatedAt: now,
			ejectedAt:
				state === 'accepted' ? (existing.ejectedAt ?? now) : existing.ejectedAt,
			archivedAt: state === 'archived' ? (existing.archivedAt ?? now) : null,
		});
		await this.repository.appendAuditEvent({
			tenantId: tenant,
			actorId: actor,
			action:
				state === 'archived'
					? 'sandbox.session.archived'
					: state === 'deleted'
						? 'sandbox.session.deleted'
						: existing.state === 'archived'
							? 'sandbox.session.restored'
							: 'sandbox.session.state',
			subjectType: 'session',
			subjectId: session.id,
			metadata: { from: existing.state, to: state },
			occurredAt: now,
		});
		return session;
	}

	async archiveSession(
		tenantId: string,
		sessionId: string,
		actorId: string,
	): Promise<SandboxSessionRecord> {
		return this.updateSessionState(tenantId, sessionId, 'archived', actorId);
	}

	async deleteSession(
		tenantId: string,
		sessionId: string,
		actorId: string,
	): Promise<SandboxSessionRecord> {
		return this.updateSessionState(tenantId, sessionId, 'deleted', actorId);
	}

	async listSessions(
		tenantId: string,
		limit = SESSION_LIST_LIMIT,
	): Promise<readonly SandboxSessionRecord[]> {
		return await this.repository.listSessions(
			identifier(tenantId, 'tenantId'),
			Math.min(Math.max(limit, 1), SESSION_LIST_LIMIT),
		);
	}

	async findSession(
		tenantId: string,
		sessionId: string,
	): Promise<SandboxSessionRecord | null> {
		return await this.repository.findSession(
			identifier(tenantId, 'tenantId'),
			identifier(sessionId, 'sessionId'),
		);
	}

	async recordEject(
		tenantId: string,
		sessionId: string,
		actorId: string,
		metadata: Readonly<Record<string, string | number | boolean>>,
	): Promise<SandboxAuditEvent> {
		return await this.repository.appendAuditEvent({
			tenantId: identifier(tenantId, 'tenantId'),
			actorId: identifier(actorId, 'actorId'),
			action: 'sandbox.module.ejected',
			subjectType: 'module',
			subjectId: identifier(sessionId, 'sessionId'),
			metadata,
			occurredAt: this.#now(),
		});
	}

	async listAuditEvents(
		tenantId: string,
		limit = 100,
	): Promise<readonly SandboxAuditEvent[]> {
		return await this.repository.listAuditEvents(
			identifier(tenantId, 'tenantId'),
			Math.min(Math.max(limit, 1), 500),
		);
	}

	async pageAuditEvents(
		tenantId: string,
		cursor: string | null,
		limit = DEFAULT_AUDIT_PAGE,
	): Promise<SandboxAuditPage> {
		const size = Number.isSafeInteger(limit)
			? Math.min(Math.max(1, Math.trunc(limit)), MAX_AUDIT_PAGE)
			: DEFAULT_AUDIT_PAGE;
		return await this.repository.pageAuditEvents(
			identifier(tenantId, 'tenantId'),
			auditCursor(cursor),
			size,
		);
	}

	async verifyAuditChain(tenantId: string): Promise<boolean> {
		return await this.repository.verifyAuditChain(
			identifier(tenantId, 'tenantId'),
		);
	}

	async verifyAudit(tenantId: string): Promise<SandboxAuditChainVerification> {
		return await this.repository.verifyAuditChainDetailed(
			identifier(tenantId, 'tenantId'),
		);
	}

	#expiry(value: number | null, now: number): number | null {
		if (value === null) return null;
		if (!Number.isSafeInteger(value) || value <= now) {
			throw new SandboxServiceError(
				'INVALID_EXPIRY',
				'Grant expiry must be a future timestamp in milliseconds.',
				400,
			);
		}
		if (value - now > MAX_GRANT_LIFETIME_MS) {
			throw new SandboxServiceError(
				'EXPIRY_TOO_DISTANT',
				'A sandbox grant cannot last longer than one year.',
				400,
			);
		}
		return value;
	}
}

export { SandboxServiceError } from './sandbox-service-error.ts';
