import {
	AUDIT_EVENT_ACTIONS,
	AUDIT_REASONS,
	HOLD_SCOPE_KINDS,
	HOLD_STATUSES,
	type AuditLegalHold,
	type HoldScopeKind,
	type HoldStatus,
	type LiftHoldInput,
	type PlaceHoldInput,
} from '../domain/types.ts';
import { classIdentifier } from './retention-service.ts';
import type { AuditRepository } from './repository.ts';
import {
	AuditServiceError,
	bounded,
	boundedInteger,
	oneOf,
} from './service-error.ts';

/** Active holds one workspace may carry. A hold is a rare, deliberate act. */
export const HOLD_LIMITS = {
	active: 500,
	page: 200,
	reason: 400,
	accountId: 64,
} as const;

/**
 * What the sweep and an erasure learn before they touch a row. `heldBack` is
 * the number of rows the decision withheld where audit.core owns the class and
 * can count them; null says only the owning module could.
 */
export interface HoldDecision {
	readonly held: boolean;
	readonly holdIds: readonly string[];
	readonly heldBack: number | null;
}

export const NOT_HELD: HoldDecision = Object.freeze({
	held: false,
	holdIds: Object.freeze([]),
	heldBack: null,
});

/**
 * Whether an active hold covers one class of one workspace. Replaced in tests
 * and by the runtime with the registry-backed check; the shipped default of a
 * process that composes no holds answers that nothing is held.
 */
export type LegalHoldCheck = (input: {
	readonly tenantId: string;
	readonly classId: string;
}) => Promise<HoldDecision>;

export const noLegalHolds: LegalHoldCheck = async () => NOT_HELD;

/**
 * A hold covers a class when it names no class or names this one. An account or
 * a date range narrows rows, not classes, and the kernel sweep input carries no
 * row predicate, so such a hold withholds every class it can reach. The
 * over-approximation is the safe direction and the spec states it.
 */
export function holdCoversClass(
	hold: AuditLegalHold,
	classId: string,
): boolean {
	return hold.classId === null || hold.classId === classId;
}

/** A hold covers a subject when it names no account or names this one. */
export function holdCoversSubject(
	hold: AuditLegalHold,
	accountId: string,
): boolean {
	return hold.accountId === null || hold.accountId === accountId;
}

export class AuditHoldService {
	constructor(
		private readonly repository: AuditRepository,
		private readonly now: () => number = Date.now,
	) {}

	async list(
		tenantId: string,
		status: HoldStatus | undefined,
		limit = HOLD_LIMITS.page,
	): Promise<readonly AuditLegalHold[]> {
		return this.repository.listHolds(tenantId, status, page(limit));
	}

	async active(tenantId: string): Promise<readonly AuditLegalHold[]> {
		return this.repository.listActiveHolds(tenantId, HOLD_LIMITS.active);
	}

	async place(
		tenantId: string,
		actorId: string,
		input: PlaceHoldInput,
	): Promise<AuditLegalHold> {
		const scopeKind = oneOf<HoldScopeKind>(
			input.scopeKind,
			'scopeKind',
			HOLD_SCOPE_KINDS,
		);
		const reason = bounded(input.reason ?? '', 'reason', 1, HOLD_LIMITS.reason);
		const scope = this.#scope(scopeKind, input);
		const active = await this.active(tenantId);
		if (active.length >= HOLD_LIMITS.active) {
			throw new AuditServiceError(
				'HOLD_LIMIT_REACHED',
				`This workspace already holds ${HOLD_LIMITS.active} active legal holds; lift one before placing another.`,
				409,
			);
		}
		const now = this.now();
		const hold = await this.repository.insertHold({
			tenantId,
			scopeKind,
			...scope,
			reason,
			placedBy: actorId,
			placedAt: now,
		});
		await this.#event(hold, AUDIT_EVENT_ACTIONS.holdPlaced, actorId, {
			scopeKind,
			accountId: hold.accountId,
			classId: hold.classId,
			fromAt: hold.fromAt,
			toAt: hold.toAt,
			reason,
		});
		return hold;
	}

	async lift(
		tenantId: string,
		actorId: string,
		input: LiftHoldInput,
	): Promise<AuditLegalHold> {
		const id = bounded(input.id ?? '', 'id', 1, 64);
		const reason = bounded(input.reason ?? '', 'reason', 1, HOLD_LIMITS.reason);
		const existing = await this.repository.getHold(tenantId, id);
		if (!existing) {
			throw new AuditServiceError(
				'HOLD_NOT_FOUND',
				`This workspace holds no legal hold ${id}.`,
				404,
			);
		}
		/* Lifting an already lifted hold changes nothing and answers the same
		   row, so a repeated click is not a second audit event. */
		if (existing.status === 'lifted') return existing;
		const lifted = await this.repository.liftHold({
			tenantId,
			id,
			liftedBy: actorId,
			liftReason: reason,
			liftedAt: this.now(),
		});
		if (!lifted) return (await this.repository.getHold(tenantId, id))!;
		await this.#event(lifted, AUDIT_EVENT_ACTIONS.holdLifted, actorId, {
			scopeKind: lifted.scopeKind,
			accountId: lifted.accountId,
			classId: lifted.classId,
			reason,
		});
		return lifted;
	}

	/** The decision the sweep reads before it calls an owner. */
	async forClass(input: {
		readonly tenantId: string;
		readonly classId: string;
	}): Promise<HoldDecision> {
		const covering = (await this.active(input.tenantId)).filter((hold) =>
			holdCoversClass(hold, input.classId),
		);
		if (covering.length === 0) return NOT_HELD;
		return {
			held: true,
			holdIds: covering.map((hold) => hold.id),
			heldBack: null,
		};
	}

	/** The decision an erasure reads before it calls any owner. */
	async forSubject(tenantId: string, accountId: string): Promise<HoldDecision> {
		const covering = (await this.active(tenantId)).filter((hold) =>
			holdCoversSubject(hold, accountId),
		);
		return covering.length === 0
			? NOT_HELD
			: {
					held: true,
					holdIds: covering.map((hold) => hold.id),
					heldBack: null,
				};
	}

	#scope(
		scopeKind: HoldScopeKind,
		input: PlaceHoldInput,
	): {
		accountId: string | null;
		classId: string | null;
		fromAt: number | null;
		toAt: number | null;
	} {
		const accountId = input.accountId
			? bounded(input.accountId, 'accountId', 1, HOLD_LIMITS.accountId)
			: null;
		const classId = input.classId ? classIdentifier(input.classId) : null;
		const fromAt = timestamp(input.fromAt, 'fromAt');
		const toAt = timestamp(input.toAt, 'toAt');
		const scope = { accountId, classId, fromAt, toAt };
		if (scopeKind === 'workspace') {
			if (accountId || classId || fromAt !== null || toAt !== null) {
				throw new AuditServiceError(
					'HOLD_SCOPE_INVALID',
					'A workspace hold covers everything and takes no account, class or date range.',
				);
			}
			return scope;
		}
		if (scopeKind === 'account' && !accountId) {
			throw new AuditServiceError(
				'HOLD_SCOPE_INVALID',
				'An account hold needs the account it covers.',
			);
		}
		if (scopeKind === 'data-class' && !classId) {
			throw new AuditServiceError(
				'HOLD_SCOPE_INVALID',
				'A data class hold needs the class it covers.',
			);
		}
		if (scopeKind === 'date-range' && (fromAt === null || toAt === null)) {
			throw new AuditServiceError(
				'HOLD_SCOPE_INVALID',
				'A date range hold needs both ends of the range.',
			);
		}
		if (fromAt !== null && toAt !== null && toAt < fromAt) {
			throw new AuditServiceError(
				'HOLD_SCOPE_INVALID',
				'The end of the range is before its start.',
			);
		}
		return scope;
	}

	/* A hold names a person, so the event is sealed under that person's key
	   when it has one and under the operator otherwise; the reason travels
	   inside the envelope with it. */
	async #event(
		hold: AuditLegalHold,
		action: string,
		actorId: string,
		metadata: Readonly<Record<string, unknown>>,
	): Promise<void> {
		await this.repository.appendAuditEvent({
			tenantId: hold.tenantId,
			actorId,
			action,
			subjectType: 'legal-hold',
			subjectId: hold.id,
			metadata,
			occurredAt: this.now(),
			subjectAccountId: hold.accountId ?? actorId,
		});
	}
}

/** The stable code every refusal under a hold carries. */
export const HOLD_ACTIVE = AUDIT_REASONS.holdActive;

export function holdStatusOrUndefined(value: string): HoldStatus | undefined {
	return (HOLD_STATUSES as readonly string[]).includes(value)
		? (value as HoldStatus)
		: undefined;
}

function page(limit: number): number {
	return Math.min(Math.max(Math.trunc(limit) || 1, 1), HOLD_LIMITS.page);
}

function timestamp(
	value: number | null | undefined,
	field: string,
): number | null {
	if (value === undefined || value === null) return null;
	return boundedInteger(value, field, 0, 8_640_000_000_000_000);
}
