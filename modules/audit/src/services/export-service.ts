import { createHash } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
	DataClassDeclaration,
	DataClassExportSink,
	PlatformDataClassRegistry,
} from '@flowdular/kernel';
import { JOB_CLAIM_LOST } from '@flowdular/server';
import {
	AUDIT_EVENT_ACTIONS,
	type AuditDataClass,
	type AuditExportRun,
	type ExportRunSummary,
} from '../domain/types.ts';
import type { BackupEvidence, BackupGuard } from './backup-guard.ts';
import { DeclaredDataClasses } from './declared-classes.ts';
import { exportOutputDirectory } from './export-directory.ts';
import { readPlatformVersion } from './platform-version.ts';
import type { AuditRepository } from './repository.ts';
import { AuditRetentionService } from './retention-service.ts';
import { AuditServiceError } from './service-error.ts';
import { StoredZipWriter } from './zip.ts';

export const EXPORT_FORMAT_VERSION = 'audit-export/1';

/** Bounds. A hostile or broken owner must not grow the process or the disk. */
export const EXPORT_LIMITS = {
	rowBytes: 262_144,
	rowsPerClass: 1_000_000,
	/** Classes and exclusions one run row names before it says so. */
	summaryEntries: 256,
} as const;

/** Requested runs one pass takes, so one pass never holds the loop. */
export const EXPORT_ROUTING_PAGE = 20;

/**
 * How often the platform looks for requested runs. An operator waits for the
 * answer, so the loop is faster than the retention sweep; an idle deployment
 * pays one indexed routing read per interval and nothing else.
 */
export const EXPORT_POLL_INTERVAL_MS = 5_000;

/**
 * How long a claim holds a run. A platform process that died mid-export leaves
 * its claim behind; after this the next process takes the run over rather than
 * leaving the operator waiting for a process that is gone.
 */
export const EXPORT_CLAIM_TIMEOUT_MS = 15 * 60_000;

/** How long the operator command waits for the platform to answer a run. */
export const EXPORT_WAIT = {
	timeoutMs: 10 * 60_000,
	pollMs: 1_000,
} as const;

/** Stable reasons a class is in the manifest but not in the archive. */
export const EXPORT_EXCLUSIONS = {
	declared: 'DECLARED_NOT_EXPORTABLE',
	noOperation: 'NO_EXPORT_OPERATION',
	ownerNotComposed: 'OWNER_MODULE_NOT_COMPOSED',
} as const;

/** The exclusions that leave the archive short of what the workspace holds. */
const INCOMPLETE_REASONS: readonly string[] = [
	EXPORT_EXCLUSIONS.noOperation,
	EXPORT_EXCLUSIONS.ownerNotComposed,
];

function incompleteExclusions(
	exclusions: readonly { readonly reason: string }[],
): boolean {
	return exclusions.some((entry) => INCOMPLETE_REASONS.includes(entry.reason));
}

export interface ExportedClass {
	readonly classId: string;
	readonly moduleId: string;
	readonly label: string;
	/** Path of the JSON Lines entry inside the archive. */
	readonly file: string;
	readonly rows: number;
	readonly from: string | null;
	readonly to: string | null;
}

export interface ExportExclusion {
	readonly classId: string;
	readonly moduleId: string;
	readonly label: string;
	readonly reason: string;
	/** The owner module's own words when it declared the class not exportable. */
	readonly declaredReason: string | null;
}

export interface ExportManifest {
	readonly formatVersion: string;
	readonly generatedAt: string;
	readonly platformVersion: string;
	readonly workspace: {
		readonly tenantId: string;
		readonly slug: string | null;
		readonly name: string | null;
	};
	/**
	 * True when every class the workspace holds was either exported or excluded
	 * by its own declaration. False when a class has no composed owner or no
	 * export operation, which the exclusions name one by one.
	 */
	readonly complete: boolean;
	readonly backup: {
		readonly manifestPath: string;
		readonly createdAt: string;
		readonly adapter: string;
		readonly platformVersion: string;
		readonly keys: readonly {
			readonly variable: string;
			readonly fingerprint: string | null;
		}[];
	};
	readonly classes: readonly ExportedClass[];
	readonly exclusions: readonly ExportExclusion[];
	readonly totals: { readonly classes: number; readonly rows: number };
}

export interface ExportRequestInput {
	readonly tenantId: string;
	readonly slug?: string | null;
	readonly name?: string | null;
	/** The operator label recorded on the export run. */
	readonly requestedBy: string;
	/** Absolute and inside the directory the deployment allows. */
	readonly outputDirectory: string;
	/** Without it the platform counts through every owner and writes nothing. */
	readonly apply: boolean;
}

export interface ExportRefusal {
	readonly reason: string;
	readonly detail: string;
}

export interface ExportResult {
	/** An archive was written. False for a plan and for a refused run. */
	readonly applied: boolean;
	readonly dryRun: boolean;
	readonly refused: ExportRefusal | null;
	readonly archivePath: string | null;
	readonly archiveDigest: string | null;
	readonly manifest: ExportManifest | null;
	readonly run: AuditExportRun;
}

export interface ExportServiceOptions {
	readonly repository: AuditRepository;
	readonly registry: PlatformDataClassRegistry;
	readonly retention: AuditRetentionService;
	readonly backup: BackupGuard;
	readonly environment: NodeJS.ProcessEnv;
	readonly workspaceRoot: string;
	/** Recorded in the manifest; read from the workspace configuration once. */
	readonly platformVersion?: () => Promise<string>;
	readonly now?: () => number;
}

interface ClassPlan {
	readonly record: AuditDataClass;
	readonly declaration: DataClassDeclaration | null;
}

/**
 * One per-workspace export, in two halves. The operator command records the
 * request and waits; the running platform, the only process holding the sealed
 * data class registry with every owner port, performs it. Every read runs
 * under the workspace's own transaction inside the owning module, so row-level
 * security is what enforces the boundary: audit.core opens no foreign table
 * and holds no foreign lease.
 */
export class AuditExportService {
	readonly #repository: AuditRepository;
	readonly #declared: DeclaredDataClasses;
	readonly #retention: AuditRetentionService;
	readonly #backup: BackupGuard;
	readonly #environment: NodeJS.ProcessEnv;
	readonly #workspaceRoot: string;
	readonly #platformVersion: () => Promise<string>;
	readonly #now: () => number;
	#version: Promise<string> | undefined;

	constructor(options: ExportServiceOptions) {
		this.#repository = options.repository;
		this.#declared = new DeclaredDataClasses(options.registry);
		this.#retention = options.retention;
		this.#backup = options.backup;
		this.#environment = options.environment;
		this.#workspaceRoot = options.workspaceRoot;
		this.#platformVersion =
			options.platformVersion ??
			(() => readPlatformVersion(this.#workspaceRoot));
		this.#now = options.now ?? Date.now;
	}

	/**
	 * Records what the operator asked for. The directory is checked here so the
	 * command answers a bad request immediately instead of recording a run the
	 * platform will only refuse.
	 */
	async request(input: ExportRequestInput): Promise<AuditExportRun> {
		return this.#repository.startExportRun({
			tenantId: input.tenantId,
			formatVersion: EXPORT_FORMAT_VERSION,
			requestedBy: input.requestedBy,
			outputDirectory: this.#directory(input.outputDirectory),
			dryRun: !input.apply,
			workspaceSlug: input.slug ?? null,
			workspaceName: input.name ?? null,
			startedAt: this.#now(),
		});
	}

	/**
	 * Answers one claimed run. It records a failure as the run's own outcome
	 * rather than throwing, because the operator reads the ledger, not this
	 * process's log. The one thing it does throw is a lost claim: that run
	 * belongs to the process holding it now, and this one settles nothing.
	 */
	async perform(
		run: AuditExportRun,
		signal?: AbortSignal,
	): Promise<ExportResult> {
		try {
			await this.#event(run, AUDIT_EVENT_ACTIONS.exportStarted, {
				formatVersion: run.formatVersion,
				requestedBy: run.requestedBy,
				dryRun: run.dryRun,
			});
			const backup = await this.#backup();
			if (!backup.ok) {
				return await this.#fail(run, backup.reason, backup.detail);
			}
			/* The stored request is data: the directory the deployment allows may
			   have changed, or the row may have been edited. */
			const directory = run.dryRun
				? null
				: this.#directory(run.outputDirectory ?? '');
			const plans = await this.#plan(run.tenantId);
			return directory === null
				? await this.#count(run, plans, backup.evidence, signal)
				: await this.#archive(run, directory, plans, backup.evidence, signal);
		} catch (error) {
			/* The lease lapsed and another loop reclaimed the run while this one
			   was working. Recording a failure here would settle a row that is
			   somebody else's work now. */
			if (signal?.aborted) throw error;
			return this.#fail(
				run,
				error instanceof AuditServiceError ? error.code : 'EXPORT_FAILED',
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/**
	 * The claim fence, read once per class. The runner renews the claim on its
	 * own timer and aborts this signal when a renewal matches nothing, so a run
	 * longer than the lease stops here instead of writing an archive for a claim
	 * it no longer holds.
	 */
	#checkpoint(signal: AbortSignal | undefined): void {
		if (!signal?.aborted) return;
		throw new AuditServiceError(
			JOB_CLAIM_LOST,
			'Another process took this export run over while it was running.',
			409,
		);
	}

	#directory(requested: string): string {
		return exportOutputDirectory({
			environment: this.#environment,
			workspaceRoot: this.#workspaceRoot,
			requested,
		});
	}

	async #plan(tenantId: string): Promise<readonly ClassPlan[]> {
		/* The stored rows are the workspace's own view, so a class whose module
		   is no longer composed is still named instead of quietly vanishing. */
		await this.#retention.materialize(tenantId);
		const stored = await this.#repository.listDataClasses(tenantId);
		return stored.map((record) => ({
			record,
			declaration: this.#declared.resolve(record.classId)?.declaration ?? null,
		}));
	}

	/** The plan reads through the same owner ports and writes no archive. */
	async #count(
		run: AuditExportRun,
		plans: readonly ClassPlan[],
		backup: BackupEvidence,
		signal: AbortSignal | undefined,
	): Promise<ExportResult> {
		const classes: ExportedClass[] = [];
		const exclusions: ExportExclusion[] = [];
		for (const plan of plans) {
			this.#checkpoint(signal);
			const excluded = exclusionFor(plan);
			if (excluded) {
				exclusions.push(excluded);
				continue;
			}
			let rows = 0;
			const summary = await runOwnerExport(plan, run.tenantId, async () => {
				rows += 1;
				bound(rows, plan.record.classId);
			});
			classes.push(exportedClass(plan.record, rows, summary));
		}
		const manifest = await this.#manifest(run, backup, classes, exclusions);
		return this.#complete(run, manifest, null, null);
	}

	async #archive(
		run: AuditExportRun,
		directory: string,
		plans: readonly ClassPlan[],
		backup: BackupEvidence,
		signal: AbortSignal | undefined,
	): Promise<ExportResult> {
		/* The mode reaches only the directories this call creates; one that
		   already exists keeps the mode it was made with. */
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const archivePath = resolve(directory, archiveName(run));
		const digest = createHash('sha256');
		/* A claim taken over from a process that died leaves that process's
		   partial archive at this path; it is this run's own file, and the
		   archive is created exclusively so nothing else can be written over. */
		await rm(archivePath, { force: true });
		const handle = await open(archivePath, 'wx', 0o600);
		const classes: ExportedClass[] = [];
		const exclusions: ExportExclusion[] = [];
		try {
			const writer = new StoredZipWriter(
				{
					write: async (data) => {
						digest.update(data);
						await handle.write(data);
					},
				},
				new Date(run.startedAt),
			);
			for (const plan of plans) {
				this.#checkpoint(signal);
				const excluded = exclusionFor(plan);
				if (excluded) {
					exclusions.push(excluded);
					continue;
				}
				const file = entryName(plan.record.classId);
				await writer.addEntry(file);
				let rows = 0;
				const summary = await runOwnerExport(
					plan,
					run.tenantId,
					async (row) => {
						rows += 1;
						bound(rows, plan.record.classId);
						await writer.write(jsonLine(row, plan.record.classId));
					},
				);
				await writer.closeEntry();
				classes.push(exportedClass(plan.record, rows, summary, file));
			}
			const manifest = await this.#manifest(run, backup, classes, exclusions);
			await writer.addEntry('manifest.json');
			await writer.write(
				Buffer.from(`${JSON.stringify(manifest, null, '\t')}\n`, 'utf8'),
			);
			await writer.closeEntry();
			await writer.finish();
			await handle.close();
			return this.#complete(run, manifest, archivePath, digest.digest('hex'));
		} catch (error) {
			/* An export is complete or it does not exist: a half-written archive
			   would be read as the workspace's data. The run itself is recorded
			   as failed by the caller, which is the one place that records it. */
			await handle.close().catch(() => undefined);
			await rm(archivePath, { force: true });
			throw error;
		}
	}

	async #complete(
		run: AuditExportRun,
		manifest: ExportManifest,
		archivePath: string | null,
		archiveDigest: string | null,
	): Promise<ExportResult> {
		const summary = runSummary(manifest);
		const finished = await this.#repository.finishExportRun({
			tenantId: run.tenantId,
			id: run.id,
			status: 'completed',
			classes: manifest.totals.classes,
			rows: manifest.totals.rows,
			archiveDigest,
			archivePath,
			reason: null,
			summary,
			completedAt: this.#now(),
		});
		await this.#event(run, AUDIT_EVENT_ACTIONS.exportCompleted, {
			archiveDigest,
			classes: manifest.totals.classes,
			rows: manifest.totals.rows,
			complete: manifest.complete,
			dryRun: run.dryRun,
		});
		return {
			applied: archivePath !== null,
			dryRun: run.dryRun,
			refused: null,
			archivePath,
			archiveDigest,
			manifest,
			run: finished ?? { ...run, status: 'completed', summary },
		};
	}

	async #fail(
		run: AuditExportRun,
		reason: string,
		detail: string,
	): Promise<ExportResult> {
		const code = reason.slice(0, 64);
		const at = this.#now();
		const failed = await this.#repository.finishExportRun({
			tenantId: run.tenantId,
			id: run.id,
			status: 'failed',
			classes: 0,
			rows: 0,
			archiveDigest: null,
			archivePath: null,
			reason: code,
			summary: null,
			completedAt: at,
		});
		await this.#event(run, AUDIT_EVENT_ACTIONS.exportFailed, {
			reason: code,
			detail,
		});
		return {
			applied: false,
			dryRun: run.dryRun,
			refused: { reason: code, detail },
			archivePath: null,
			archiveDigest: null,
			manifest: null,
			run: failed ?? { ...run, status: 'failed', reason: code },
		};
	}

	async #manifest(
		run: AuditExportRun,
		backup: BackupEvidence,
		classes: readonly ExportedClass[],
		exclusions: readonly ExportExclusion[],
	): Promise<ExportManifest> {
		return {
			formatVersion: EXPORT_FORMAT_VERSION,
			generatedAt: new Date(this.#now()).toISOString(),
			platformVersion: await (this.#version ??= this.#platformVersion()),
			workspace: {
				tenantId: run.tenantId,
				slug: run.workspaceSlug,
				name: run.workspaceName,
			},
			complete: !incompleteExclusions(exclusions),
			backup: {
				manifestPath: backup.manifestPath,
				createdAt: backup.createdAt,
				adapter: backup.adapter,
				platformVersion: backup.platformVersion,
				keys: backup.keys.map((key) => ({
					variable: key.variable,
					fingerprint: key.fingerprint,
				})),
			},
			classes,
			exclusions,
			totals: {
				classes: classes.length,
				rows: classes.reduce((total, entry) => total + entry.rows, 0),
			},
		};
	}

	async #event(
		run: AuditExportRun,
		action: string,
		metadata: Readonly<Record<string, unknown>>,
	): Promise<void> {
		await this.#repository.appendAuditEvent({
			tenantId: run.tenantId,
			actorId: run.requestedBy,
			action,
			subjectType: 'export-run',
			subjectId: run.id,
			metadata,
			occurredAt: this.#now(),
		});
	}
}

/**
 * Waits for the platform to answer one run. The command that recorded the
 * request polls the row it wrote: only the running platform holds the sealed
 * registry, so a deployment whose platform is down never answers and the wait
 * ends with a stable reason naming the run.
 */
export async function awaitExportRun(
	repository: AuditRepository,
	tenantId: string,
	id: string,
	options: {
		readonly timeoutMs?: number;
		readonly pollMs?: number;
		readonly now?: () => number;
		readonly sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<AuditExportRun> {
	const now = options.now ?? Date.now;
	const sleep =
		options.sleep ??
		((ms: number) =>
			new Promise<void>((settle) => {
				setTimeout(settle, ms).unref?.();
			}));
	const pollMs = options.pollMs ?? EXPORT_WAIT.pollMs;
	const deadline = now() + (options.timeoutMs ?? EXPORT_WAIT.timeoutMs);
	for (;;) {
		const run = await repository.getExportRun(tenantId, id);
		if (!run) {
			throw new AuditServiceError(
				'EXPORT_RUN_NOT_FOUND',
				`The export run ${id} is no longer recorded in this workspace.`,
				404,
			);
		}
		if (run.status !== 'started') return run;
		if (now() >= deadline) {
			throw new AuditServiceError(
				'EXPORT_NOT_ANSWERED',
				`The export run ${id} is still requested. Only the running platform performs an export; start it and read the run with "flowdular audit export" history.`,
				504,
			);
		}
		await sleep(pollMs);
	}
}

function runSummary(manifest: ExportManifest): ExportRunSummary {
	const cap = EXPORT_LIMITS.summaryEntries;
	return {
		complete: manifest.complete,
		classes: manifest.classes.slice(0, cap).map((entry) => ({
			classId: entry.classId,
			rows: entry.rows,
			from: entry.from,
			to: entry.to,
		})),
		exclusions: manifest.exclusions.slice(0, cap).map((entry) => ({
			classId: entry.classId,
			reason: entry.reason,
		})),
		/* The archive carries every class; one stored row names at most `cap` of
		   them, and says so rather than looking complete. */
		truncated:
			manifest.classes.length > cap || manifest.exclusions.length > cap,
	};
}

function exclusionFor(plan: ClassPlan): ExportExclusion | null {
	const base = {
		classId: plan.record.classId,
		moduleId: plan.record.moduleId,
		label: plan.record.label,
	};
	if (!plan.declaration) {
		return {
			...base,
			reason: EXPORT_EXCLUSIONS.ownerNotComposed,
			declaredReason: null,
		};
	}
	if (!plan.declaration.exportable) {
		return {
			...base,
			reason: EXPORT_EXCLUSIONS.declared,
			declaredReason: plan.declaration.excludedReason ?? null,
		};
	}
	if (!plan.declaration.export) {
		return {
			...base,
			reason: EXPORT_EXCLUSIONS.noOperation,
			declaredReason: null,
		};
	}
	return null;
}

/* `exclusionFor` answered null for this plan, so both are present. */
function exportOperation(
	plan: ClassPlan,
): NonNullable<DataClassDeclaration['export']> {
	const operation = plan.declaration?.export;
	if (!operation) {
		throw new AuditServiceError(
			'OWNER_EXPORT_FAILED',
			`${plan.record.classId} has no export operation.`,
			500,
		);
	}
	return operation;
}

/* Foreign code. A failure is the export's failure: an archive missing a class
   it claims to carry is worse than no archive. */
async function runOwnerExport(
	plan: ClassPlan,
	tenantId: string,
	write: DataClassExportSink['write'],
): Promise<{ from: Date | null; to: Date | null }> {
	try {
		const summary = await exportOperation(plan)({ tenantId, sink: { write } });
		return { from: summary?.from ?? null, to: summary?.to ?? null };
	} catch (error) {
		if (error instanceof AuditServiceError) throw error;
		throw new AuditServiceError(
			'OWNER_EXPORT_FAILED',
			`${plan.record.moduleId} could not export ${plan.record.classId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
			502,
		);
	}
}

function exportedClass(
	record: AuditDataClass,
	rows: number,
	summary: { from: Date | null; to: Date | null },
	file = entryName(record.classId),
): ExportedClass {
	return {
		classId: record.classId,
		moduleId: record.moduleId,
		label: record.label,
		file,
		/* The count the sink saw, not the one the owner reported: the archive is
		   the record, so the manifest states what it actually holds. */
		rows,
		from: isoOrNull(summary.from),
		to: isoOrNull(summary.to),
	};
}

function isoOrNull(value: Date | null): string | null {
	return value instanceof Date && Number.isFinite(value.getTime())
		? value.toISOString()
		: null;
}

function entryName(classId: string): string {
	return `classes/${classId}.jsonl`;
}

function bound(rows: number, classId: string): void {
	if (rows > EXPORT_LIMITS.rowsPerClass) {
		throw new AuditServiceError(
			'EXPORT_CLASS_TOO_LARGE',
			`${classId} exported more than ${EXPORT_LIMITS.rowsPerClass} rows.`,
			507,
		);
	}
}

function jsonLine(row: Record<string, unknown>, classId: string): Buffer {
	const line = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
	if (line.byteLength > EXPORT_LIMITS.rowBytes) {
		throw new AuditServiceError(
			'EXPORT_ROW_TOO_LARGE',
			`${classId} exported a row larger than ${EXPORT_LIMITS.rowBytes} bytes.`,
			507,
		);
	}
	return line;
}

/* The run id is part of the name: two requests of one workspace can carry the
   same start time, and each archive is the record of exactly one run. */
function archiveName(run: AuditExportRun): string {
	const stamp = new Date(run.startedAt)
		.toISOString()
		.replaceAll(/[:.]/g, '')
		.replace(/-/g, '');
	const safe = run.tenantId.replaceAll(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
	const suffix = run.id.replaceAll(/[^A-Za-z0-9]/g, '').slice(0, 8);
	return `audit-export-${safe}-${stamp}-${suffix}.zip`;
}
