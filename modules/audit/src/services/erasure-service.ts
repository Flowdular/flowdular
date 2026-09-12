import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
	DataClassCountInput,
	DataClassErasureInput,
	DataClassErasureResult,
	PlatformDataClassRegistry,
} from '@flowdular/kernel';
import { JOB_CLAIM_LOST } from '@flowdular/server';
import {
	AUDIT_EVENT_ACTIONS,
	AUDIT_REASONS,
	type AuditErasureRun,
	type AuditSubjectKey,
	type ErasureClassOutcome,
} from '../domain/types.ts';
import { DeclaredDataClasses } from './declared-classes.ts';
import { exportOutputDirectory } from './export-directory.ts';
import { AuditHoldService } from './hold-service.ts';
import { ERASURE_LIMITS, type AuditErasureRegistry } from './erasure-port.ts';
import type { AuditRepository } from './repository.ts';
import { AuditServiceError, bounded } from './service-error.ts';
import { erasureSubjectMarker } from './subject-keys.ts';

export const ERASURE_CERTIFICATE_VERSION = 'audit-erasure/1';

/** Requested runs one pass takes, so one pass never holds the loop. */
export const ERASURE_ROUTING_PAGE = 10;

/**
 * How often the platform looks for requested erasures. An operator waits for
 * the answer, so the loop is as responsive as the export one; an idle
 * deployment pays one indexed routing read per interval.
 */
export const ERASURE_POLL_INTERVAL_MS = 5_000;

/** How long a claim holds a run whose process died mid-erasure. */
export const ERASURE_CLAIM_TIMEOUT_MS = 15 * 60_000;

/**
 * How long a request nobody answered stays requested. A command records the row
 * and waits ten minutes; a deployment whose platform was down for longer must
 * not carry the request for ever, or the ledger grows with work that will never
 * be performed and the routing read pages through it on every interval.
 */
export const ERASURE_REQUEST_TTL_MS = 24 * 60 * 60_000;

/** How long the operator command waits for the platform to answer a run. */
export const ERASURE_WAIT = {
	timeoutMs: 10 * 60_000,
	pollMs: 1_000,
} as const;

export type { ErasureClassOutcome };
export { erasureSubjectMarker };

export interface ErasureCertificate {
	readonly formatVersion: string;
	readonly workspace: {
		readonly tenantId: string;
		readonly slug: string | null;
		readonly name: string | null;
	};
	readonly subject: string;
	readonly applied: boolean;
	/** False when a class was truncated or failed, so the subject is still in one. */
	readonly complete: boolean;
	readonly classes: readonly ErasureClassOutcome[];
	readonly totals: {
		readonly classes: number;
		/** Rows the owners took out; a redacted row is not one of them. */
		readonly rows: number;
		/** Rows they kept but stripped of the subject, in a ledger or a snapshot. */
		readonly redacted: number;
		/** Classes that declare no erase operation, named on the certificate. */
		readonly notErasable: number;
	};
	readonly subjectKey: {
		readonly requested: boolean;
		readonly state: string | null;
		readonly destroyedAt: string | null;
	};
	/** The newest anchor of the workspace, so the certificate names the chain. */
	readonly anchor: {
		readonly anchorSequence: number;
		readonly toSequence: number;
		readonly anchorHash: string;
	} | null;
	readonly operator: string;
	readonly startedAt: string;
	readonly completedAt: string;
}

export interface ErasureResult {
	readonly applied: boolean;
	readonly subject: string;
	readonly classes: readonly ErasureClassOutcome[];
	/** False when a class was truncated or failed; the run is recorded partial. */
	readonly complete: boolean;
	readonly certificate: ErasureCertificate | null;
	readonly certificatePath: string | null;
	readonly subjectKey: AuditSubjectKey | null;
}

export interface ErasureRequest {
	readonly tenantId: string;
	readonly subject: string;
	readonly slug?: string | null;
	readonly name?: string | null;
	readonly operator: string;
	/** Absolute and inside the directory the deployment allows. */
	readonly outputDirectory: string;
	readonly apply: boolean;
	/** Also destroys the subject's audit data key, for ever. */
	readonly destroyKey: boolean;
}

export interface ErasureServiceOptions {
	readonly repository: AuditRepository;
	readonly holds: AuditHoldService;
	/**
	 * The sealed platform catalogue. Every class it carries gets an outcome, so
	 * a plan and a certificate name the whole deployment rather than only the
	 * classes that happen to be erasable.
	 */
	readonly dataClasses: PlatformDataClassRegistry;
	/** The audit.erasure.v1 adapter, for a class that registered there instead. */
	readonly adapter?: AuditErasureRegistry;
	readonly environment: NodeJS.ProcessEnv;
	readonly workspaceRoot: string;
	readonly now?: () => number;
}

/** One class as the run sees it: the declaration and the adapter resolved once. */
interface ErasableClass {
	readonly moduleId: string;
	readonly classId: string;
	readonly erase:
		| ((input: DataClassErasureInput) => Promise<DataClassErasureResult>)
		| null;
	readonly count:
		| ((input: DataClassCountInput) => Promise<number | null>)
		| null;
}

/**
 * Erasure on request. audit.core owns no foreign table, so a class is erased by
 * the module that owns it, through the operation its data class declaration
 * carries; audit.core orders the run, refuses it under a hold, writes the trail
 * around it and hands the operator a certificate that names every class of the
 * deployment and what happened to it.
 */
export class AuditErasureService {
	readonly #repository: AuditRepository;
	readonly #holds: AuditHoldService;
	readonly #declared: DeclaredDataClasses;
	readonly #adapter: AuditErasureRegistry | null;
	readonly #environment: NodeJS.ProcessEnv;
	readonly #workspaceRoot: string;
	readonly #now: () => number;

	constructor(options: ErasureServiceOptions) {
		this.#repository = options.repository;
		this.#holds = options.holds;
		this.#declared = new DeclaredDataClasses(options.dataClasses);
		this.#adapter = options.adapter ?? null;
		this.#environment = options.environment;
		this.#workspaceRoot = options.workspaceRoot;
		this.#now = options.now ?? Date.now;
	}

	/**
	 * Records what the operator asked for. The directory is checked here so the
	 * command answers a bad request immediately instead of recording a run the
	 * platform will only refuse.
	 */
	async request(
		input: ErasureRequest & { readonly subjectMarker?: string },
	): Promise<AuditErasureRun> {
		const subject = bounded(input.subject, 'subject', 1, 64);
		return this.#repository.startErasureRun({
			tenantId: input.tenantId,
			subject,
			subjectMarker:
				input.subjectMarker ?? erasureSubjectMarker(input.tenantId, subject),
			requestedBy: input.operator,
			/* Resolved for a plan too: an operator learns that the directory is
			   refused before being told how much would be removed. */
			outputDirectory: this.#directory(input.outputDirectory),
			dryRun: !input.apply,
			destroyKey: input.destroyKey,
			workspaceSlug: input.slug ?? null,
			workspaceName: input.name ?? null,
			startedAt: this.#now(),
		});
	}

	/**
	 * Answers one claimed run. It records a refusal as the run's own outcome
	 * rather than throwing, because the operator reads the ledger, not this
	 * process's log. The one thing it does throw is a lost claim: that run
	 * belongs to the process holding it now, and this one settles nothing.
	 */
	async perform(
		record: AuditErasureRun,
		signal?: AbortSignal,
	): Promise<AuditErasureRun> {
		/* The caller claimed the row first, so the request this process expires is
		   one no other process is performing. */
		if (record.startedAt <= this.#now() - ERASURE_REQUEST_TTL_MS) {
			return (
				(await this.#finish(record, 'failed', {
					reason: AUDIT_REASONS.erasureRequestExpired,
				})) ?? record
			);
		}
		const subject = record.subject;
		if (!subject) {
			return (
				(await this.#finish(record, 'failed', {
					reason: 'ERASURE_SUBJECT_MISSING',
				})) ?? record
			);
		}
		try {
			const result = await this.run(
				{
					tenantId: record.tenantId,
					subject,
					slug: record.workspaceSlug,
					name: record.workspaceName,
					operator: record.requestedBy,
					outputDirectory: record.outputDirectory ?? '',
					apply: !record.dryRun,
					destroyKey: record.destroyKey,
				},
				signal,
			);
			return (
				(await this.#finish(
					record,
					result.applied && !result.complete ? 'partial' : 'completed',
					{
						classes: result.classes.length,
						rows: result.classes.reduce(
							(total, entry) => total + (entry.rows ?? 0),
							0,
						),
						certificatePath: result.certificatePath,
						outcome: result.classes,
					},
				)) ?? record
			);
		} catch (error) {
			/* The lease lapsed and another loop reclaimed the run while this one
			   was working. Recording a refusal here would settle a row that is
			   somebody else's work now. */
			if (signal?.aborted) throw error;
			return (
				(await this.#finish(record, 'failed', {
					reason:
						error instanceof AuditServiceError
							? error.code.slice(0, 64)
							: 'ERASURE_FAILED',
				})) ?? record
			);
		}
	}

	/**
	 * The claim fence, read once per class. The runner renews the claim on its
	 * own timer and aborts this signal when a renewal matches nothing, so a run
	 * longer than the lease stops between two classes instead of erasing on
	 * behalf of a claim it no longer holds.
	 */
	#checkpoint(signal: AbortSignal | undefined): void {
		if (!signal?.aborted) return;
		throw new AuditServiceError(
			JOB_CLAIM_LOST,
			'Another process took this erasure run over while it was running.',
			409,
		);
	}

	async #finish(
		record: AuditErasureRun,
		status: 'completed' | 'partial' | 'failed',
		fields: {
			readonly classes?: number;
			readonly rows?: number;
			readonly certificatePath?: string | null;
			readonly outcome?: readonly ErasureClassOutcome[] | null;
			readonly reason?: string | null;
		},
	): Promise<AuditErasureRun | null> {
		return this.#repository.finishErasureRun({
			tenantId: record.tenantId,
			id: record.id,
			status,
			classes: fields.classes ?? 0,
			rows: fields.rows ?? 0,
			certificatePath: fields.certificatePath ?? null,
			outcome: fields.outcome ?? null,
			reason: fields.reason ?? null,
			completedAt: this.#now(),
		});
	}

	async run(
		request: ErasureRequest,
		signal?: AbortSignal,
	): Promise<ErasureResult> {
		const subject = bounded(request.subject, 'subject', 1, 64);
		const startedAt = this.#now();
		/* Checked before anything is counted: a plan that walked every owner
		   under a hold would already have read what it may not touch. */
		const hold = await this.#holds.forSubject(request.tenantId, subject);
		if (hold.held) {
			throw new AuditServiceError(
				AUDIT_REASONS.holdActive,
				`A legal hold covers ${subject} in this workspace (${hold.holdIds.join(', ')}). Lift it before erasing.`,
				409,
			);
		}
		/* The directory is resolved before any row is removed, so an erasure
		   never happens without somewhere to write the certificate that proves
		   it did. */
		const directory = request.apply
			? this.#directory(request.outputDirectory)
			: null;
		const classes = this.#classes();
		const marker = erasureSubjectMarker(request.tenantId, subject);
		if (!request.apply) {
			const planned = await this.#plan(
				request.tenantId,
				subject,
				classes,
				signal,
			);
			return {
				applied: false,
				subject,
				classes: planned,
				complete: planned.every((entry) => entry.outcome !== 'failed'),
				certificate: null,
				certificatePath: null,
				subjectKey: await this.#subjectKey(request.tenantId, subject, marker),
			};
		}
		/* A subject whose key was destroyed by an earlier run must not be sealed
		   under a new one: that would put the account back in the clear in the
		   very events the destruction made unreadable. */
		const keyBefore = await this.#subjectKey(request.tenantId, subject, marker);
		const keyGone = keyBefore?.state === 'destroyed';
		await this.#event(
			request,
			subject,
			AUDIT_EVENT_ACTIONS.erasureStarted,
			startedAt,
			{ classes: classes.length, destroyKey: request.destroyKey },
			keyGone,
		);
		const outcomes: ErasureClassOutcome[] = [];
		for (const entry of classes) {
			this.#checkpoint(signal);
			outcomes.push(await this.#erase(entry, request.tenantId, subject));
		}
		/* Asked once more before the irreversible half: destroying a subject key
		   and signing a certificate for a claim this process no longer holds
		   cannot be taken back, and the run belongs to its new owner. */
		this.#checkpoint(signal);
		/* The key goes before the closing event is written: an event sealed under
		   a key that was just destroyed would create a new one and leave the
		   subject readable again. */
		const subjectKey = request.destroyKey
			? await this.#destroyKey(request, subject, marker)
			: keyBefore;
		const destroyed = subjectKey?.state === 'destroyed';
		const completedAt = this.#now();
		const certificate = this.#certificate({
			request,
			subject,
			classes: outcomes,
			subjectKey,
			anchor: await this.#repository.latestAnchor(request.tenantId),
			startedAt,
			completedAt,
		});
		const certificatePath = await this.#writeCertificate(
			directory!,
			request.tenantId,
			certificate,
		);
		await this.#event(
			request,
			subject,
			AUDIT_EVENT_ACTIONS.erasureCompleted,
			completedAt,
			{
				classes: certificate.totals.classes,
				rows: certificate.totals.rows,
				complete: certificate.complete,
				certificate: certificatePath,
				keyDestroyed: destroyed,
			},
			destroyed || keyGone,
		);
		return {
			applied: true,
			subject,
			classes: outcomes,
			complete: certificate.complete,
			certificate,
			certificatePath,
			subjectKey,
		};
	}

	/**
	 * Every class of the sealed catalogue, with its erase and count resolved
	 * once. The declaration is the source of truth and the audit.erasure.v1
	 * adapter only answers for a class whose declaration carries neither, so a
	 * module is never asked twice for one class.
	 */
	#classes(): readonly ErasableClass[] {
		return this.#declared.all().map((declared) => {
			const registered = this.#adapter?.get(declared.classId) ?? null;
			return {
				moduleId: declared.moduleId,
				classId: declared.classId,
				erase: declared.declaration.erase ?? registered?.erase ?? null,
				count: declared.declaration.count ?? registered?.count ?? null,
			};
		});
	}

	/** The subject's key, or the tombstone an earlier destruction left behind. */
	async #subjectKey(
		tenantId: string,
		subject: string,
		marker: string,
	): Promise<AuditSubjectKey | null> {
		const active = await this.#repository.getSubjectKey(tenantId, subject);
		if (active) return active;
		return this.#repository.getSubjectKeyByMarker(tenantId, marker);
	}

	async #plan(
		tenantId: string,
		subject: string,
		classes: readonly ErasableClass[],
		signal: AbortSignal | undefined,
	): Promise<readonly ErasureClassOutcome[]> {
		const outcomes: ErasureClassOutcome[] = [];
		for (const entry of classes) {
			this.#checkpoint(signal);
			const outcome = entry.erase ? 'erasable' : 'not-erasable';
			if (!entry.count) {
				outcomes.push({
					moduleId: entry.moduleId,
					classId: entry.classId,
					outcome,
					rows: null,
				});
				continue;
			}
			try {
				/* Foreign code. A class that cannot answer must not stop the plan:
				   the operator still needs to see the rest before deciding. */
				const rows = await entry.count({
					tenantId,
					subject: { accountId: subject },
				});
				outcomes.push({
					moduleId: entry.moduleId,
					classId: entry.classId,
					outcome,
					rows: rows === null ? null : Math.max(0, Math.trunc(rows)),
				});
			} catch (error) {
				outcomes.push({
					moduleId: entry.moduleId,
					classId: entry.classId,
					outcome,
					rows: null,
					failure: message(error),
				});
			}
		}
		return outcomes;
	}

	async #erase(
		entry: ErasableClass,
		tenantId: string,
		subject: string,
	): Promise<ErasureClassOutcome> {
		if (!entry.erase) {
			return {
				moduleId: entry.moduleId,
				classId: entry.classId,
				outcome: 'not-erasable',
				rows: null,
			};
		}
		let erased = 0;
		let redacted = 0;
		let truncated = false;
		for (let batch = 1; batch <= ERASURE_LIMITS.batches; batch += 1) {
			let answer: DataClassErasureResult;
			try {
				/* Foreign code. A failing class is recorded on the certificate and
				   the run continues, because a subject erased from four of five
				   classes is better than one erased from none, and the certificate
				   is what says which. */
				answer = await entry.erase({
					tenantId,
					subject: { accountId: subject },
					limit: ERASURE_LIMITS.batch,
				});
			} catch (error) {
				return {
					moduleId: entry.moduleId,
					classId: entry.classId,
					outcome: 'failed',
					rows: erased,
					...(redacted > 0 ? { redacted } : {}),
					failure: message(error),
				};
			}
			/* An unreadable count is no progress: the class is recorded truncated
			   instead of looping through every batch on a NaN comparison. */
			const removed = progressCount(answer?.removed);
			const stripped = progressCount(answer?.redacted);
			if (removed === null || stripped === null) {
				truncated = true;
				break;
			}
			erased += removed;
			redacted += stripped;
			truncated = answer?.truncated === true;
			/* A row the owner kept but stripped of the subject is as much progress
			   as one it took, so a class that can only redact runs to its end. A
			   class that did neither has nothing left to do, whatever it says about
			   the rest; its own flag is still what the certificate records. */
			const cleared = removed + stripped;
			if (cleared === 0) break;
			if (!truncated && cleared < ERASURE_LIMITS.batch) break;
			if (batch === ERASURE_LIMITS.batches) truncated = true;
		}
		return {
			moduleId: entry.moduleId,
			classId: entry.classId,
			outcome: 'erased',
			rows: erased,
			...(redacted > 0 ? { redacted } : {}),
			...(truncated ? { truncated: true } : {}),
		};
	}

	async #destroyKey(
		request: ErasureRequest,
		subject: string,
		marker: string,
	): Promise<AuditSubjectKey | null> {
		const destroyed = await this.#repository.destroySubjectKey(
			request.tenantId,
			subject,
			this.#now(),
		);
		if (!destroyed) {
			/* Already a tombstone: found by its marker, because the account it
			   belonged to is exactly what destruction removed. */
			return this.#repository.getSubjectKeyByMarker(request.tenantId, marker);
		}
		/* Written after the key is gone and never sealed under it: this event is
		   the proof the destruction happened and must stay readable. */
		await this.#repository.appendAuditEvent({
			tenantId: request.tenantId,
			actorId: request.operator,
			action: AUDIT_EVENT_ACTIONS.subjectKeyDestroyed,
			subjectType: 'erasure',
			subjectId: destroyed.id,
			metadata: { subjectKeyId: destroyed.id },
			occurredAt: this.#now(),
		});
		return destroyed;
	}

	#certificate(input: {
		readonly request: ErasureRequest;
		readonly subject: string;
		readonly classes: readonly ErasureClassOutcome[];
		readonly subjectKey: AuditSubjectKey | null;
		readonly anchor: Awaited<ReturnType<AuditRepository['latestAnchor']>>;
		readonly startedAt: number;
		readonly completedAt: number;
	}): ErasureCertificate {
		return {
			formatVersion: ERASURE_CERTIFICATE_VERSION,
			workspace: {
				tenantId: input.request.tenantId,
				slug: input.request.slug ?? null,
				name: input.request.name ?? null,
			},
			subject: input.subject,
			applied: true,
			complete: input.classes.every(
				(entry) => entry.outcome !== 'failed' && entry.truncated !== true,
			),
			classes: input.classes,
			totals: {
				classes: input.classes.length,
				rows: input.classes.reduce(
					(total, entry) => total + (entry.rows ?? 0),
					0,
				),
				redacted: input.classes.reduce(
					(total, entry) => total + (entry.redacted ?? 0),
					0,
				),
				notErasable: input.classes.filter(
					(entry) => entry.outcome === 'not-erasable',
				).length,
			},
			subjectKey: {
				requested: input.request.destroyKey,
				state: input.subjectKey?.state ?? null,
				destroyedAt:
					input.subjectKey?.destroyedAt == null
						? null
						: new Date(input.subjectKey.destroyedAt).toISOString(),
			},
			anchor: input.anchor
				? {
						anchorSequence: input.anchor.anchorSequence,
						toSequence: input.anchor.toSequence,
						anchorHash: input.anchor.anchorHash,
					}
				: null,
			operator: input.request.operator,
			startedAt: new Date(input.startedAt).toISOString(),
			completedAt: new Date(input.completedAt).toISOString(),
		};
	}

	async #writeCertificate(
		directory: string,
		tenantId: string,
		certificate: ErasureCertificate,
	): Promise<string> {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const stamp = new Date(certificate.completedAt)
			.toISOString()
			.replaceAll(/[:.]/g, '')
			.replaceAll('-', '');
		/* The subject is hashed into the name: a directory listing must not be a
		   list of the people a workspace erased. */
		const marker = erasureSubjectMarker(tenantId, certificate.subject);
		const path = resolve(
			directory,
			`audit-erasure-${safe(tenantId)}-${stamp}-${marker}.json`,
		);
		const handle = await open(path, 'wx', 0o600);
		try {
			await handle.write(`${JSON.stringify(certificate, null, '\t')}\n`);
		} finally {
			await handle.close();
		}
		return path;
	}

	#directory(requested: string): string {
		return exportOutputDirectory({
			environment: this.#environment,
			workspaceRoot: this.#workspaceRoot,
			requested,
		});
	}

	/**
	 * Sealed under the subject's own key, so destroying that key also takes the
	 * account identifier out of the events that record the erasure; what is left
	 * proves an erasure happened at a time, which is the point of keeping them.
	 * Once the key is gone the subject is named by its marker instead, because a
	 * new key would put the account back in the clear.
	 */
	async #event(
		request: ErasureRequest,
		subject: string,
		action: string,
		occurredAt: number,
		metadata: Readonly<Record<string, unknown>>,
		keyDestroyed = false,
	): Promise<void> {
		await this.#repository.appendAuditEvent({
			tenantId: request.tenantId,
			actorId: keyDestroyed ? 'audit.core' : request.operator,
			action,
			subjectType: 'erasure',
			subjectId: keyDestroyed
				? erasureSubjectMarker(request.tenantId, subject)
				: subject,
			metadata,
			occurredAt,
			...(keyDestroyed ? {} : { subjectAccountId: subject }),
		});
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function safe(value: string): string {
	return value.replaceAll(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
}

/**
 * Waits for the platform to answer one erasure. The command that recorded the
 * request polls the row it wrote: only the running platform holds every
 * module's erase operation, so a deployment whose platform is down never
 * answers and the wait ends with a stable reason naming the run.
 */
export async function awaitErasureRun(
	repository: AuditRepository,
	tenantId: string,
	id: string,
	options: {
		readonly timeoutMs?: number;
		readonly pollMs?: number;
		readonly now?: () => number;
		readonly sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<AuditErasureRun> {
	const now = options.now ?? Date.now;
	const sleep =
		options.sleep ??
		((ms: number) =>
			new Promise<void>((settle) => {
				setTimeout(settle, ms).unref?.();
			}));
	const pollMs = options.pollMs ?? ERASURE_WAIT.pollMs;
	const deadline = now() + (options.timeoutMs ?? ERASURE_WAIT.timeoutMs);
	for (;;) {
		const run = await repository.getErasureRun(tenantId, id);
		if (!run) {
			throw new AuditServiceError(
				'ERASURE_RUN_NOT_FOUND',
				`The erasure run ${id} is no longer recorded in this workspace.`,
				404,
			);
		}
		if (run.status !== 'requested') return run;
		if (now() >= deadline) {
			throw new AuditServiceError(
				'ERASURE_NOT_ANSWERED',
				`The erasure run ${id} is still requested. Only the running platform performs an erasure; start it and read the run in the workspace's erasure history.`,
				504,
			);
		}
		await sleep(pollMs);
	}
}

function progressCount(value: unknown): number | null {
	if (value === undefined) return 0;
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	return Math.max(0, Math.trunc(value));
}
