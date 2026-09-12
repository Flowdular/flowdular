import type {
	DataClassDeclaration,
	PlatformDataClassRegistry,
} from '@flowdular/kernel';
import {
	AUDIT_EVENT_ACTIONS,
	AUDIT_REASONS,
	type AuditDataClass,
	type SweepStatus,
} from '../domain/types.ts';
import type { BackupGuard, BackupGuardResult } from './backup-guard.ts';
import { DeclaredDataClasses } from './declared-classes.ts';
import { noLegalHolds, type LegalHoldCheck } from './hold-service.ts';
import { AUDIT_EVENTS_CLASS_ID } from './own-classes.ts';
import type { AuditRepository, DataClassRouting } from './repository.ts';
import { AuditServiceError } from './service-error.ts';

const DAY_MS = 86_400_000;

/**
 * Classes one pass looks at. The pass is bounded so a deployment with many
 * workspaces spreads its work over intervals instead of holding the loop.
 */
export const SWEEP_ROUTING_PAGE = 50;

/**
 * Batches one class may take in one pass. Without it a class whose owner keeps
 * answering a full batch would hold the pass for as long as it has rows; the
 * class is recorded as `partial` and picked up again at the next interval.
 */
export const SWEEP_MAX_BATCHES = 20;

export interface SweepServiceOptions {
	readonly repository: AuditRepository;
	readonly registry: PlatformDataClassRegistry;
	readonly backup: BackupGuard;
	/** Live platform settings, read again on every pass. */
	readonly batchSize: () => number;
	readonly intervalMs: () => number;
	readonly holds?: LegalHoldCheck;
	readonly now?: () => number;
}

/**
 * One due class as the pass that found it saw it: the routing row, the instant
 * the pass read, and the backup evidence it refuses under. The instant and the
 * evidence are the pass's own, so every class of one pass sweeps against the
 * same cutoff and one backup read answers for all of them.
 */
export interface DueDataClass {
	readonly routing: DataClassRouting;
	readonly at: number;
	readonly backup: BackupGuardResult;
}

/**
 * The retention work of one class at a time. Due classes are found across
 * workspaces on the routing lease, every class is read again under the
 * workspace the routing row named, and the removal itself happens inside the
 * owning module. The loop over them is the platform job runner's.
 */
export class AuditSweepService {
	readonly #repository: AuditRepository;
	readonly #declared: DeclaredDataClasses;
	readonly #backup: BackupGuard;
	readonly #batchSize: () => number;
	readonly #intervalMs: () => number;
	readonly #holds: LegalHoldCheck;
	readonly #now: () => number;

	constructor(options: SweepServiceOptions) {
		this.#repository = options.repository;
		this.#declared = new DeclaredDataClasses(options.registry);
		this.#backup = options.backup;
		this.#batchSize = options.batchSize;
		this.#intervalMs = options.intervalMs;
		this.#holds = options.holds ?? noLegalHolds;
		this.#now = options.now ?? Date.now;
	}

	/**
	 * The classes one pass looks at, found across workspaces on the routing
	 * lease. The backup evidence is read once here and carried on every class,
	 * not asked per class: the answer is a property of the deployment and reading
	 * it per class would be a file read per row. An idle pass reads neither.
	 */
	async due(limit = SWEEP_ROUTING_PAGE): Promise<readonly DueDataClass[]> {
		const at = this.#now();
		const due = await this.#repository.listDueDataClasses(
			at - this.#intervalMs(),
			limit,
		);
		if (due.length === 0) return [];
		const backup = await this.#backup();
		return due.map((routing) => ({ routing, at, backup }));
	}

	/**
	 * One due class: refused for the deployment, withheld under an active hold,
	 * left to the next pass when the workspace moved it, or swept.
	 */
	async sweep(due: DueDataClass): Promise<void> {
		const { routing, at, backup } = due;
		if (!backup.ok) {
			await this.#refuse(
				routing.tenantId,
				routing.classId,
				AUDIT_REASONS.backupManifestMissing,
				at,
			);
			return;
		}
		/* The routing read crosses tenants and returns routing columns only.
		   The class is read again under the workspace that row named, and one
		   that moved in between is left to the next pass rather than swept
		   against a period that is no longer current. */
		const record = await this.#repository.getDataClass(
			routing.tenantId,
			routing.classId,
		);
		if (
			!record ||
			record.lastSweptAt !== routing.lastSweptAt ||
			record.effectiveRetentionDays === null
		) {
			return;
		}
		const owner = this.#declared.resolve(record.classId);
		if (!owner?.declaration.sweep) return;
		const hold = await this.#holds({
			tenantId: record.tenantId,
			classId: record.classId,
		});
		if (hold.held) {
			const heldBack =
				hold.heldBack ??
				(await this.#countHeld(record, record.effectiveRetentionDays, at));
			await this.#refuse(
				record.tenantId,
				record.classId,
				AUDIT_REASONS.holdActive,
				at,
				heldBack,
			);
			return;
		}
		await this.#sweepClass(
			record,
			record.effectiveRetentionDays,
			owner.declaration.sweep,
			at,
		);
	}

	/**
	 * Rows the hold withheld, for the one class audit.core owns and sweeps. A
	 * foreign class is withheld whole and only its owner could count it, which
	 * the ledger records as an absent count rather than a zero.
	 */
	async #countHeld(
		record: AuditDataClass,
		retentionDays: number,
		now: number,
	): Promise<number | null> {
		if (record.classId !== AUDIT_EVENTS_CLASS_ID) return null;
		return this.#repository.countAuditEventsBefore(
			record.tenantId,
			now - retentionDays * DAY_MS,
			null,
		);
	}

	async #sweepClass(
		record: AuditDataClass,
		retentionDays: number,
		sweep: NonNullable<DataClassDeclaration['sweep']>,
		now: number,
	): Promise<void> {
		const limit = this.#batchSize();
		const cutoffMs = now - retentionDays * DAY_MS;
		const cutoff = new Date(cutoffMs);
		let removed = 0;
		let status: SweepStatus = 'completed';
		let reason: string | null = null;
		for (let batch = 1; batch <= SWEEP_MAX_BATCHES; batch += 1) {
			/* The event is written before the rows are gone, so the trail records
			   what was about to be removed even if the removal itself fails. */
			await this.#repository.appendAuditEvent({
				tenantId: record.tenantId,
				actorId: 'audit.core',
				action: AUDIT_EVENT_ACTIONS.retentionSweep,
				subjectType: 'data-class',
				subjectId: record.classId,
				metadata: {
					classId: record.classId,
					cutoff: cutoff.toISOString(),
					retentionDays,
					batch,
					limit,
				},
				occurredAt: this.#now(),
			});
			let batchRemoved: number;
			try {
				/* Foreign code. A faulty owner must not stop the pass or leave the
				   class looking swept, so the failure becomes the ledger outcome. */
				const answer = await sweep({
					tenantId: record.tenantId,
					cutoff,
					limit,
				});
				batchRemoved = Math.max(0, Math.trunc(answer?.removed ?? 0));
			} catch (error) {
				status = removed > 0 ? 'partial' : 'refused';
				/* Foreign code, but an owner that names a stable reason gets it
				   recorded: the ledger is what an operator reads, and "the owner
				   failed" hides a condition an operator can actually answer. */
				reason =
					error instanceof AuditServiceError
						? error.code
						: AUDIT_REASONS.ownerSweepFailed;
				break;
			}
			removed += batchRemoved;
			if (batchRemoved < limit) break;
			if (batch === SWEEP_MAX_BATCHES) {
				status = 'partial';
				reason = AUDIT_REASONS.batchCapReached;
			}
		}
		/* A refusal that stands until the deployment answers it is recorded once;
		   repeating it every interval would grow the ledger without adding
		   anything a reader did not already have. */
		const standing =
			status === 'refused' &&
			(await this.#repository.latestSweepRun(record.tenantId, record.classId));
		if (
			!standing ||
			standing.status !== 'refused' ||
			standing.reason !== reason
		) {
			await this.#repository.appendSweepRun({
				tenantId: record.tenantId,
				classId: record.classId,
				cutoff: cutoffMs,
				removed,
				status,
				reason,
				heldBack: null,
				occurredAt: this.#now(),
			});
		}
		/* A refused pass leaves the stamp alone so the class stays due; anything
		   that removed rows moves on to the next interval. */
		if (status !== 'refused') {
			await this.#repository.stampSwept(
				record.tenantId,
				record.classId,
				this.#now(),
			);
		}
	}

	/**
	 * Records a standing refusal once. Repeating it every interval would grow
	 * the ledger without adding anything: the reason is answered by fixing the
	 * deployment, not by the next pass.
	 */
	async #refuse(
		tenantId: string,
		classId: string,
		reason: string,
		now: number,
		heldBack: number | null = null,
	): Promise<void> {
		const latest = await this.#repository.latestSweepRun(tenantId, classId);
		if (latest?.status === 'refused' && latest.reason === reason) return;
		await this.#repository.appendSweepRun({
			tenantId,
			classId,
			cutoff: now,
			removed: 0,
			status: 'refused',
			reason,
			heldBack,
			occurredAt: now,
		});
		await this.#repository.appendAuditEvent({
			tenantId,
			actorId: 'audit.core',
			action: AUDIT_EVENT_ACTIONS.retentionRefused,
			subjectType: 'data-class',
			subjectId: classId,
			metadata: { classId, reason },
			occurredAt: now,
		});
	}
}
