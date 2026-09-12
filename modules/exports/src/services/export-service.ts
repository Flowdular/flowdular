import { randomUUID } from 'node:crypto';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	runListExport,
	ListExportError,
	type ListExportPrincipal,
} from '@flowdular/server';
import { StorageError, type StoragePort } from '@flowdular/storage';
import {
	EXPORT_LIMITS,
	EXPORT_UNEXPECTED_FAILURE,
	type ClaimedExportJob,
	type ExportJob,
	type ExportListView,
	type ExportRequester,
} from '../domain/types.ts';
import type { ExportListRegistry } from './list-registry.ts';
import type {
	ExportJobPage,
	ExportJobQuery,
	ExportRepository,
} from './repository.ts';

export class ExportServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'ExportServiceError';
	}
}

/** The module id every object of this module lives under in the storage port. */
export const EXPORT_OWNER_MODULE = 'exports.core';

export const EXPORT_CSV_CONTENT_TYPE = 'text/csv';

/** How long a minted read URL lives. Long enough to click, short enough to lose. */
export const EXPORT_READ_URL_SECONDS = 300;

export interface ExportServiceOptions {
	readonly repository: ExportRepository;
	readonly lists: ExportListRegistry;
	readonly storage: StoragePort;
	readonly maxRows: () => number;
	readonly maxBytes: () => number;
	/** The storage port's own object ceiling, which bounds the same bytes. */
	readonly maxObjectBytes: () => number;
	readonly now?: () => number;
	readonly newId?: () => string;
}

function requesterOf(principal: AuthPrincipal): ExportRequester {
	const requester: ExportRequester = {
		accountId: principal.accountId,
		email: principal.email,
		displayName: principal.displayName,
		role: principal.role,
		scopes: [...principal.scopes],
	};
	/* The job row bounds the snapshot at 8 KB. A principal carrying more than
	   that is refused here with a code the screen can read, rather than by the
	   column check once the job is half written. */
	if (JSON.stringify(requester).length > EXPORT_LIMITS.json) {
		throw new ExportServiceError(
			'REQUESTER_TOO_LARGE',
			'Your account carries more grants than an export job can record.',
		);
	}
	return requester;
}

/**
 * The requester the list sees in the background stage. It carries the identity
 * and the grants held when the job was started; the workspace is the job's own,
 * and other workspace memberships are never part of an export.
 */
function principalOf(job: ExportJob): ListExportPrincipal {
	return {
		accountId: job.requester.accountId,
		tenantId: job.tenantId,
		scopes: job.requester.scopes,
	};
}

/* One stable code per way a stage can end badly. A storage refusal on size is
   the byte bound the operator already knows about, reported as that bound
   rather than as a second one underneath it. */
function failureCodeOf(error: unknown): string {
	if (error instanceof ListExportError) return error.code;
	if (error instanceof StorageError) {
		return error.code === 'OBJECT_TOO_LARGE'
			? 'EXPORT_BYTES_EXCEEDED'
			: 'EXPORT_STORAGE_FAILED';
	}
	if (error instanceof ExportServiceError) return error.code;
	return EXPORT_UNEXPECTED_FAILURE;
}

/**
 * The catalogue a reader sees. It needs the sealed registry and the caller's
 * scopes only, so the endpoint answers it without a repository or a lease.
 */
export function exportCatalogue(
	lists: Pick<ExportListRegistry, 'list'>,
	principal: AuthPrincipal,
): readonly ExportListView[] {
	const held = new Set(principal.scopes);
	return lists.list().map((entry) => ({
		id: entry.id,
		label: entry.definition.label,
		moduleId: entry.moduleId,
		permitted: held.has(entry.definition.permission),
	}));
}

export class ExportService {
	readonly #repository: ExportRepository;
	readonly #lists: ExportListRegistry;
	readonly #storage: StoragePort;
	readonly #maxRows: () => number;
	readonly #maxBytes: () => number;
	readonly #maxObjectBytes: () => number;
	readonly #now: () => number;
	readonly #newId: () => string;

	constructor(options: ExportServiceOptions) {
		this.#repository = options.repository;
		this.#lists = options.lists;
		this.#storage = options.storage;
		this.#maxRows = options.maxRows;
		this.#maxBytes = options.maxBytes;
		this.#maxObjectBytes = options.maxObjectBytes;
		this.#now = options.now ?? (() => Date.now());
		this.#newId = options.newId ?? (() => randomUUID());
	}

	/* The storage port refuses an object above its own ceiling, and it counts the
	   same plaintext bytes the walk does. A walk bounded above the ceiling would
	   read the list to its end and build the whole file only to have the write
	   refused, so the lower of the two is applied before the first page. Both
	   refusals are reported under EXPORT_BYTES_EXCEEDED either way. */
	#bytesBound(): number {
		return Math.min(this.#maxBytes(), this.#maxObjectBytes());
	}

	async start(principal: AuthPrincipal, listId: string): Promise<ExportJob> {
		const registered = this.#lists.find(listId);
		if (!registered) {
			throw new ExportServiceError(
				'EXPORT_LIST_UNKNOWN',
				'No module registered a list export under that id.',
				404,
			);
		}
		/* The list's own permission, checked on the acting principal before
		   anything is recorded, so an export never widens what a member may
		   read. */
		if (!principal.scopes.includes(registered.definition.permission)) {
			throw new ExportServiceError(
				'EXPORT_LIST_FORBIDDEN',
				'You do not hold the permission this list requires.',
				403,
			);
		}
		const startedAt = this.#now();
		return this.#repository.createJob({
			id: this.#newId(),
			tenantId: principal.tenantId,
			listId: registered.id,
			status: 'requested',
			rowCount: 0,
			byteCount: 0,
			objectId: null,
			requesterAccountId: principal.accountId,
			requester: requesterOf(principal),
			failureCode: null,
			claimedAt: null,
			startedAt,
			completedAt: null,
		});
	}

	/**
	 * The catalogue as one principal sees it: every registered list, each marked
	 * with whether that principal holds the permission the list declares. The
	 * permission is decided again on the live principal when a job is started, so
	 * this is what a screen offers and never what authorizes an export.
	 */
	jobs(tenantId: string, query: ExportJobQuery): Promise<ExportJobPage> {
		return this.#repository.listJobs(tenantId, query);
	}

	async job(tenantId: string, id: string): Promise<ExportJob> {
		const job = await this.#repository.findJob(tenantId, id);
		if (!job) {
			throw new ExportServiceError(
				'EXPORT_JOB_NOT_FOUND',
				'That export job does not exist in this workspace.',
				404,
			);
		}
		return job;
	}

	/**
	 * A signed platform route for the file of a completed job. It is minted per
	 * request and never stored, so a signed credential does not reach a log line
	 * or a page of results.
	 */
	async readUrl(principal: AuthPrincipal, id: string): Promise<string> {
		const tenantId = principal.tenantId;
		const job = await this.job(tenantId, id);
		/* The file holds the rows of the exported list, so opening it needs that
		   list's own permission on the live principal and not only the permission
		   to read jobs. Otherwise a member who may see the job list could download
		   rows the list itself would never have shown them, and a grant revoked
		   after the export would still hand the file over. */
		const registered = this.#lists.find(job.listId);
		if (!registered) {
			throw new ExportServiceError(
				'EXPORT_LIST_UNKNOWN',
				'No module registered the list this file was exported from.',
				404,
			);
		}
		if (!principal.scopes.includes(registered.definition.permission)) {
			throw new ExportServiceError(
				'EXPORT_LIST_FORBIDDEN',
				'You do not hold the permission this list requires.',
				403,
			);
		}
		const objectId = job.objectId;
		if (job.status !== 'completed' || objectId === null) {
			throw new ExportServiceError(
				'EXPORT_NOT_READY',
				'That export has no file to open.',
				409,
			);
		}
		const reference = {
			tenantId,
			moduleId: EXPORT_OWNER_MODULE,
			objectId,
		};
		/* Retention deletes the object before its row, so a job can name a file
		   that is already gone; the reader is told that rather than handed a URL
		   that answers nothing. */
		if ((await this.#storage.stat(reference)) === null) {
			throw new ExportServiceError(
				'EXPORT_OBJECT_GONE',
				'That export file is no longer stored.',
				404,
			);
		}
		return this.#storage.readUrl({
			...reference,
			expiresInSeconds: EXPORT_READ_URL_SECONDS,
		});
	}

	/**
	 * One claimed job: walk the list under the requester's snapshot, write the
	 * file and settle. It never throws for work it performed; a claim taken over
	 * mid-stage settles nothing and leaves the job to whoever holds it now.
	 */
	async perform(job: ClaimedExportJob, signal: AbortSignal): Promise<void> {
		const registered = this.#lists.find(job.listId);
		if (!registered) {
			/* A list that was registered when the job started and is not any more
			   means the module was disabled between the two. */
			await this.#fail(job, 'EXPORT_LIST_UNKNOWN');
			return;
		}
		let objectId: string | null = null;
		let recorded = false;
		try {
			const result = await runListExport({
				definition: registered.definition,
				principal: principalOf(job),
				bounds: { maxRows: this.#maxRows(), maxBytes: this.#bytesBound() },
				signal,
			});
			/* Nothing is written for a claim this stage no longer holds. */
			signal.throwIfAborted();
			objectId = this.#newId();
			const stored = await this.#storage.put({
				tenantId: job.tenantId,
				moduleId: EXPORT_OWNER_MODULE,
				objectId,
				contentType: EXPORT_CSV_CONTENT_TYPE,
				body: result.body,
				declaredBytes: result.bytes,
			});
			const settled = await this.#repository.settleJob(job.tenantId, job.id, {
				status: 'completed',
				rowCount: result.rows,
				byteCount: stored.bytes,
				objectId,
				failureCode: null,
				completedAt: this.#now(),
			});
			recorded = settled !== null;
		} catch (error) {
			if (!signal.aborted) await this.#fail(job, failureCodeOf(error));
		} finally {
			/* Every way this stage can end without the job row naming the object:
			   the claim changed hands, the settle raised, the abort landed between
			   the write and the settle, or the stage failed after the file existed.
			   In each of them nothing would ever reference the object and no sweep
			   would ever find it, so it goes now. */
			if (objectId !== null && !recorded) {
				await this.#discard(job.tenantId, objectId);
			}
		}
	}

	async #fail(job: ClaimedExportJob, failureCode: string): Promise<void> {
		await this.#repository.settleJob(job.tenantId, job.id, {
			status: 'failed',
			rowCount: 0,
			byteCount: 0,
			objectId: null,
			failureCode,
			completedAt: this.#now(),
		});
	}

	/* Best effort: a file that could not be deleted is one the retention sweep
	   never sees, but failing the stage over it would settle a job whose work is
	   already decided. */
	async #discard(tenantId: string, objectId: string): Promise<void> {
		try {
			await this.#storage.delete({
				tenantId,
				moduleId: EXPORT_OWNER_MODULE,
				objectId,
			});
		} catch {
			/* The object outlives its job; nothing else depends on the delete. */
		}
	}

	/** Deletes the files of a swept batch before its rows go. */
	async discardObjects(
		tenantId: string,
		objectIds: readonly string[],
	): Promise<void> {
		for (const objectId of objectIds) {
			await this.#discard(tenantId, objectId);
		}
	}
}
