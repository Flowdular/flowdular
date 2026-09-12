import { DATA_CLASS_LIMITS } from '../domain/data-classes.ts';
import {
	AUDIT_EVENT_ACTIONS,
	RETENTION_MODES,
	type AuditDataClass,
	type AuditExportRun,
	type AuditRegistryModule,
	type AuditSweepRun,
	type ExportStatus,
	type RetentionMode,
	type SetRetentionInput,
	type SweepStatus,
} from '../domain/types.ts';
import type { PlatformDataClassRegistry } from '@flowdular/kernel';
import { DeclaredDataClasses } from './declared-classes.ts';
import type { AuditRepository, DataClassFacts } from './repository.ts';
import { AuditServiceError, boundedInteger, oneOf } from './service-error.ts';

/** Longest ledger page a screen may ask for. */
export const LEDGER_PAGE_LIMIT = 200;

export function registryFacts(
	declared: DeclaredDataClasses,
): readonly DataClassFacts[] {
	return declared.all().map((entry) => ({
		classId: entry.classId,
		moduleId: entry.moduleId,
		label: entry.declaration.label,
		exportable: entry.declaration.exportable,
		sweepable: entry.declaration.sweep !== undefined,
		defaultRetentionDays: entry.declaration.defaultRetentionDays,
	}));
}

/**
 * The registry, the periods and the ledgers as one workspace sees them. Rows
 * are materialised from the declarations the first time a workspace reads them
 * and refreshed when a composition changed a label or a default, so the screen
 * follows the owning module without a migration. A workspace whose rows already
 * carry the current declarations is answered from the read alone, which is what
 * keeps the registry endpoint a read.
 */
export class AuditRetentionService {
	readonly #declared: DeclaredDataClasses;

	constructor(
		private readonly repository: AuditRepository,
		registry: PlatformDataClassRegistry,
		private readonly now: () => number = Date.now,
	) {
		this.#declared = new DeclaredDataClasses(registry);
	}

	/**
	 * Every composed module with the classes it declared, including the ones
	 * that declared none, so a workspace can see which modules hold nothing.
	 */
	async listRegistry(
		tenantId: string,
	): Promise<readonly AuditRegistryModule[]> {
		const stored = await this.materialize(tenantId);
		const byClassId = new Map(stored.map((entry) => [entry.classId, entry]));
		return this.#declared.modules().map((entry) => ({
			moduleId: entry.moduleId,
			classes: entry.classes.flatMap((declaration) => {
				const record = byClassId.get(`${entry.moduleId}.${declaration.key}`);
				return record ? [record] : [];
			}),
		}));
	}

	/** The same classes, flattened, for a table that lists them in one page. */
	async listDataClasses(tenantId: string): Promise<readonly AuditDataClass[]> {
		const modules = await this.listRegistry(tenantId);
		return modules.flatMap((entry) => entry.classes);
	}

	async materialize(tenantId: string): Promise<readonly AuditDataClass[]> {
		return this.repository.materializeDataClasses(
			tenantId,
			registryFacts(this.#declared),
			this.now(),
		);
	}

	/**
	 * Sets the workspace's period for one class. `days` is refused for a class
	 * that cannot be swept and for anything outside 1 to 36500, so a zero can
	 * never be read as "remove everything now".
	 */
	async setRetention(
		tenantId: string,
		actorId: string,
		input: SetRetentionInput,
	): Promise<AuditDataClass> {
		const classId = classIdentifier(input.classId);
		const mode = oneOf<RetentionMode>(input.mode, 'mode', RETENTION_MODES);
		const days =
			mode === 'days'
				? boundedInteger(
						input.days ?? 0,
						'days',
						1,
						DATA_CLASS_LIMITS.retentionDays,
					)
				: null;
		/* Materialising first is what lets a workspace set a period on a class it
		   has never opened a screen for. */
		await this.materialize(tenantId);
		const existing = await this.repository.getDataClass(tenantId, classId);
		if (!existing) {
			throw new AuditServiceError(
				'DATA_CLASS_NOT_FOUND',
				`No composed module declares the data class ${classId}.`,
				404,
			);
		}
		if (mode !== 'none' && !existing.sweepable) {
			throw new AuditServiceError(
				'DATA_CLASS_NOT_SWEEPABLE',
				`${classId} declares no sweep operation, so it can only be kept until a person deletes it.`,
			);
		}
		const now = this.now();
		const updated = await this.repository.setRetention(
			tenantId,
			classId,
			mode,
			days,
			now,
		);
		if (!updated) {
			throw new AuditServiceError(
				'DATA_CLASS_NOT_FOUND',
				`The data class ${classId} is not held by this workspace.`,
				404,
			);
		}
		await this.repository.appendAuditEvent({
			tenantId,
			actorId,
			action: AUDIT_EVENT_ACTIONS.retentionSet,
			subjectType: 'data-class',
			subjectId: classId,
			metadata: {
				mode,
				days,
				previousMode: existing.retentionMode,
				previousDays: existing.retentionDays,
			},
			occurredAt: now,
		});
		return updated;
	}

	async listSweepRuns(
		tenantId: string,
		status: SweepStatus | undefined,
		limit = LEDGER_PAGE_LIMIT,
	): Promise<readonly AuditSweepRun[]> {
		return this.repository.listSweepRuns(tenantId, status, page(limit));
	}

	async listExportRuns(
		tenantId: string,
		status: ExportStatus | undefined,
		limit = LEDGER_PAGE_LIMIT,
	): Promise<readonly AuditExportRun[]> {
		return this.repository.listExportRuns(tenantId, status, page(limit));
	}
}

function page(limit: number): number {
	return Math.min(Math.max(Math.trunc(limit) || 1, 1), LEDGER_PAGE_LIMIT);
}

const CLASS_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

export function classIdentifier(value: string): string {
	if (
		typeof value !== 'string' ||
		value.length > DATA_CLASS_LIMITS.classId ||
		!CLASS_ID.test(value)
	) {
		throw new AuditServiceError(
			'INVALID_INPUT',
			'classId must be a module id followed by a class key.',
		);
	}
	return value;
}
