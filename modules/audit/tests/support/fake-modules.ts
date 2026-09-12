import type {
	DataClassCountInput,
	DataClassErasureInput,
	DataClassErasureResult,
} from '@flowdular/kernel';
import type { DataClassDeclaration } from '../../src/domain/data-classes.ts';
import type { DataClassErasureEntry } from '../../src/services/erasure-port.ts';
import type {
	BackupGuard,
	BackupGuardResult,
} from '../../src/services/backup-guard.ts';

export interface FakeRow {
	readonly tenantId: string;
	readonly id: string;
	/** Epoch milliseconds; the sweep removes rows strictly older than a cutoff. */
	readonly at: number;
	readonly payload: Record<string, unknown>;
}

/**
 * A declaring module with rows of its own. The sweep and the export are exactly
 * the two operations a real owner registers, so the tests drive the same
 * boundary the platform does rather than a stand-in inside audit.core.
 */
export class FakeOwnerModule {
	#rows: FakeRow[];
	/** Batch sizes the owner was asked for, in call order. */
	readonly sweepCalls: { tenantId: string; cutoff: number; limit: number }[] =
		[];
	readonly exportCalls: string[] = [];
	readonly eraseCalls: { tenantId: string; subject: string; limit: number }[] =
		[];
	failSweep = false;
	failExport = false;
	failErase = false;
	failCount = false;
	/** Makes every erase call claim rows of the subject are left behind. */
	eraseTruncated = false;

	constructor(
		readonly moduleId: string,
		readonly key: string,
		rows: readonly FakeRow[] = [],
	) {
		this.#rows = [...rows];
	}

	get classId(): string {
		return `${this.moduleId}.${this.key}`;
	}

	rows(tenantId: string): readonly FakeRow[] {
		return this.#rows.filter((row) => row.tenantId === tenantId);
	}

	add(rows: readonly FakeRow[]): void {
		this.#rows.push(...rows);
	}

	/** Rows of one subject, which is how this owner recognises a person. */
	subjectRows(tenantId: string, subject: string): readonly FakeRow[] {
		return this.#rows.filter(
			(row) => row.tenantId === tenantId && row.payload.subject === subject,
		);
	}

	/**
	 * The erase operation a declaring module puts on its data class declaration,
	 * and the same function the audit.erasure.v1 adapter accepts. One
	 * implementation behind both, so a test that swaps the route exercises the
	 * resolution rather than two different owners.
	 */
	readonly erase = async ({
		tenantId,
		subject,
		limit,
	}: DataClassErasureInput): Promise<DataClassErasureResult> => {
		this.eraseCalls.push({ tenantId, subject: subject.accountId, limit });
		if (this.failErase) throw new Error('owner erase is broken');
		const mine = this.subjectRows(tenantId, subject.accountId);
		const doomed = mine.slice(0, limit);
		const removing = new Set(doomed.map((row) => row.id));
		this.#rows = this.#rows.filter(
			(row) => !(row.tenantId === tenantId && removing.has(row.id)),
		);
		return {
			removed: doomed.length,
			...(this.eraseTruncated ? { truncated: true } : {}),
		};
	};

	readonly count = async ({
		tenantId,
		subject,
	}: DataClassCountInput): Promise<number | null> => {
		if (this.failCount) throw new Error('owner count is broken');
		return this.subjectRows(tenantId, subject.accountId).length;
	};

	/** The registration a module makes into audit.erasure.v1 instead. */
	erasureEntry(
		options: { readonly count?: boolean } = {},
	): DataClassErasureEntry {
		return {
			moduleId: this.moduleId,
			classId: this.classId,
			erase: this.erase,
			...(options.count === false ? {} : { count: this.count }),
		};
	}

	/**
	 * A key set to `undefined` is removed rather than assigned, which is how a
	 * test declares a class that owns no sweep or no export operation under
	 * exactOptionalPropertyTypes.
	 */
	declaration(overrides: DeclarationOverrides = {}): DataClassDeclaration {
		const base: DataClassDeclaration = {
			key: this.key,
			label: `${this.moduleId} ${this.key}`,
			defaultRetentionDays: 90,
			exportable: true,
			erase: this.erase,
			count: this.count,
			sweep: async ({ tenantId, cutoff, limit }) => {
				this.sweepCalls.push({ tenantId, cutoff: cutoff.getTime(), limit });
				if (this.failSweep) throw new Error('owner sweep is broken');
				const doomed = this.#rows
					.filter(
						(row) => row.tenantId === tenantId && row.at < cutoff.getTime(),
					)
					.slice(0, limit);
				const removing = new Set(doomed.map((row) => row.id));
				this.#rows = this.#rows.filter(
					(row) => !(row.tenantId === tenantId && removing.has(row.id)),
				);
				return { removed: doomed.length };
			},
			export: async ({ tenantId, sink }) => {
				this.exportCalls.push(tenantId);
				if (this.failExport) throw new Error('owner export is broken');
				const mine = this.rows(tenantId);
				for (const row of mine) {
					await sink.write({
						id: row.id,
						at: new Date(row.at).toISOString(),
						...row.payload,
					});
				}
				const times = mine.map((row) => row.at);
				return {
					rows: mine.length,
					from: times.length === 0 ? null : new Date(Math.min(...times)),
					to: times.length === 0 ? null : new Date(Math.max(...times)),
				};
			},
		};
		const declaration: Record<string, unknown> = { ...base };
		for (const [key, value] of Object.entries(overrides)) {
			if (value === undefined) delete declaration[key];
			else declaration[key] = value;
		}
		return declaration as unknown as DataClassDeclaration;
	}
}

type DeclarationOverrides = {
	[K in keyof DataClassDeclaration]?: DataClassDeclaration[K] | undefined;
};

const EVIDENCE = {
	manifestPath: '/var/backups/flowdular/backup.json',
	createdAt: '2026-09-01T00:00:00.000Z',
	adapter: 'pglite',
	platformVersion: '0.2.0',
	keys: [
		{ variable: 'FD_AUTH_MFA_KEY', fingerprint: 'sha256:1111' },
		{ variable: 'FD_WORKFLOWS_PAYLOAD_KEY', fingerprint: null },
	],
} as const;

export function backupPresent(): BackupGuard {
	return async (): Promise<BackupGuardResult> => ({
		ok: true,
		evidence: { ...EVIDENCE, keys: [...EVIDENCE.keys] },
	});
}

export function backupMissing(): BackupGuard {
	return async (): Promise<BackupGuardResult> => ({
		ok: false,
		reason: 'BACKUP_MANIFEST_MISSING',
		detail: 'FD_AUDIT_BACKUP_MANIFEST is not set in this test.',
	});
}
