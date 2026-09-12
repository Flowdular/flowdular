import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { AUDIT_EVENT_ACTIONS, type AuditChainAnchor } from '../domain/types.ts';
import type { AnchorSigner } from './anchor-key.ts';
import { storedAuditEventHash } from './database-repository.ts';
import { exportOutputDirectory } from './export-directory.ts';
import type { AuditRepository, StoredAuditEvent } from './repository.ts';
import { AuditServiceError } from './service-error.ts';

export const SEGMENT_FORMAT_VERSION = 'audit-segment/1';

/** Bounds. A segment is a file an operator has to be able to hold and read. */
export const SEAL_LIMITS = {
	/** Events one page of the walk carries. */
	page: 500,
	/** Events one segment may close; more are sealed by the next run. */
	rowsPerSegment: 200_000,
	/**
	 * Files one verification pass reads from a directory, and anchors it reads
	 * from the workspace. Both windows take the newest end of their order, so a
	 * directory holding more than this is checked against the anchors of the
	 * same end of the chain rather than against the other one.
	 */
	filesPerVerify: 4_096,
	/** Bytes one segment file may hold before verification refuses to read it. */
	fileBytes: 256 * 1_024 * 1_024,
} as const;

/** One link of the segment chain, so neither walk ever holds a hash list. */
function chainStep(accumulator: string, eventHash: string): string {
	return createHash('sha256')
		.update(JSON.stringify([accumulator, eventHash]))
		.digest('hex');
}

/** The first line of a segment file; every line after it is an event. */
export interface SegmentAnchorLine {
	readonly kind: 'anchor';
	readonly formatVersion: string;
	readonly tenantId: string;
	readonly anchorSequence: number;
	readonly fromSequence: number;
	readonly toSequence: number;
	readonly rowCount: number;
	readonly firstOccurredAt: number;
	readonly lastOccurredAt: number;
	readonly segmentHash: string;
	readonly previousAnchorHash: string | null;
	readonly anchorHash: string;
	readonly signature: string;
	readonly keyId: string;
	readonly sealedBy: string;
	readonly sealedAt: number;
}

export interface SegmentEventLine extends StoredAuditEvent {
	readonly kind: 'event';
}

export interface SealPlan {
	readonly fromSequence: number;
	readonly toSequence: number;
	readonly rowCount: number;
	readonly firstOccurredAt: number | null;
	readonly lastOccurredAt: number | null;
	readonly previousAnchor: AuditChainAnchor | null;
	/** True when more events remain than one segment may close. */
	readonly truncated: boolean;
}

export interface SealResult {
	readonly applied: boolean;
	readonly plan: SealPlan;
	readonly segmentFile: string | null;
	readonly segmentPath: string | null;
	readonly anchor: AuditChainAnchor | null;
}

export interface SegmentVerification {
	readonly file: string;
	readonly ok: boolean;
	readonly anchorSequence: number | null;
	readonly fromSequence: number | null;
	readonly toSequence: number | null;
	readonly events: number;
	/**
	 * Events written before audit.core recorded an event format, so nothing says
	 * whether the actor and the subject of one naming a person are in the clear.
	 * An event about nobody is not one of them.
	 */
	readonly plaintextEvents: number;
	readonly signatureKeyId: string | null;
	readonly failures: readonly string[];
}

export interface VerifyReport {
	readonly ok: boolean;
	readonly directory: string;
	readonly segments: readonly SegmentVerification[];
	readonly chain: {
		readonly ok: boolean;
		readonly anchors: number;
		readonly failures: readonly string[];
	};
	readonly totals: {
		readonly events: number;
		readonly plaintextEvents: number;
	};
	/** What this pass was able to look at, so a report is read for its bound. */
	readonly window: {
		readonly limit: number;
		readonly files: number;
		readonly anchors: number;
		/**
		 * True when the directory or the chain may hold more than one pass reads,
		 * so the verification covers the newest `limit` of each and says nothing
		 * about what lies before them. A chain of exactly `limit` anchors reports
		 * it too: the read cannot tell a full window from a truncated one.
		 */
		readonly truncated: boolean;
	};
}

export interface SealRequest {
	readonly tenantId: string;
	readonly outputDirectory: string;
	readonly sealedBy: string;
	readonly apply: boolean;
}

export interface SealServiceOptions {
	readonly repository: AuditRepository;
	readonly signer: AnchorSigner;
	readonly environment: NodeJS.ProcessEnv;
	readonly workspaceRoot: string;
	readonly now?: () => number;
	/** Test seam; the shipped window is SEAL_LIMITS.filesPerVerify. */
	readonly verifyWindow?: number;
}

/**
 * One chained hash over a segment. It starts at the anchor before it, so a
 * segment can only be checked in the place the chain actually put it: moving a
 * file between directories or reordering two segments breaks the link.
 */
export function segmentChain(
	previousAnchorHash: string | null,
	eventHashes: Iterable<string>,
): string {
	let accumulator = previousAnchorHash ?? '';
	for (const hash of eventHashes) accumulator = chainStep(accumulator, hash);
	return accumulator;
}

export function anchorHashOf(input: {
	readonly tenantId: string;
	readonly anchorSequence: number;
	readonly fromSequence: number;
	readonly toSequence: number;
	readonly rowCount: number;
	readonly firstOccurredAt: number;
	readonly lastOccurredAt: number;
	readonly segmentHash: string;
	readonly previousAnchorHash: string | null;
}): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				input.tenantId,
				input.anchorSequence,
				input.fromSequence,
				input.toSequence,
				input.rowCount,
				input.firstOccurredAt,
				input.lastOccurredAt,
				input.segmentHash,
				input.previousAnchorHash,
			]),
		)
		.digest('hex');
}

/**
 * Sealing and verification of the per-workspace audit chain.
 *
 * A seal is two walks over the same closed range: the first computes the chain
 * and the bounds, the second writes the file. The range is closed before the
 * second walk starts and events only ever append, so both walks read exactly
 * the same rows and neither holds more than one page in memory.
 */
export class AuditSealService {
	readonly #repository: AuditRepository;
	readonly #signer: AnchorSigner;
	readonly #environment: NodeJS.ProcessEnv;
	readonly #workspaceRoot: string;
	readonly #now: () => number;
	readonly #verifyWindow: number;

	constructor(options: SealServiceOptions) {
		this.#repository = options.repository;
		this.#signer = options.signer;
		this.#environment = options.environment;
		this.#workspaceRoot = options.workspaceRoot;
		this.#now = options.now ?? Date.now;
		this.#verifyWindow = Math.max(
			1,
			Math.trunc(options.verifyWindow ?? SEAL_LIMITS.filesPerVerify),
		);
	}

	async plan(tenantId: string): Promise<SealPlan> {
		const previousAnchor = await this.#repository.latestAnchor(tenantId);
		const after = previousAnchor?.toSequence ?? 0;
		let rowCount = 0;
		let fromSequence = 0;
		let toSequence = after;
		let firstOccurredAt: number | null = null;
		let lastOccurredAt: number | null = null;
		const complete = await this.#walk(tenantId, after, (event) => {
			if (rowCount === 0) {
				fromSequence = event.sequence;
				firstOccurredAt = event.occurredAt;
			}
			toSequence = event.sequence;
			lastOccurredAt = event.occurredAt;
			rowCount += 1;
			return rowCount < SEAL_LIMITS.rowsPerSegment;
		});
		const truncated = !complete;
		return {
			fromSequence: rowCount === 0 ? after + 1 : fromSequence,
			toSequence,
			rowCount,
			firstOccurredAt,
			lastOccurredAt,
			previousAnchor,
			truncated,
		};
	}

	async seal(request: SealRequest): Promise<SealResult> {
		const plan = await this.plan(request.tenantId);
		if (plan.rowCount === 0) {
			throw new AuditServiceError(
				'NOTHING_TO_SEAL',
				'Every audit event of this workspace is already in a segment file.',
				409,
			);
		}
		/* Resolved for the plan too, so an operator learns that the directory is
		   refused before being told how much would be written. */
		const directory = this.#directory(request.outputDirectory);
		const segmentFile = segmentName(
			request.tenantId,
			plan.fromSequence,
			plan.toSequence,
		);
		if (!request.apply) {
			return {
				applied: false,
				plan,
				segmentFile,
				segmentPath: resolve(directory, segmentFile),
				anchor: null,
			};
		}
		let accumulator = plan.previousAnchor?.anchorHash ?? '';
		await this.#walk(
			request.tenantId,
			plan.previousAnchor?.toSequence ?? 0,
			(event) => {
				if (event.sequence > plan.toSequence) return false;
				accumulator = chainStep(accumulator, event.eventHash);
				return true;
			},
		);
		const segmentHash = accumulator;
		const anchorSequence = (plan.previousAnchor?.anchorSequence ?? 0) + 1;
		const anchorHash = anchorHashOf({
			tenantId: request.tenantId,
			anchorSequence,
			fromSequence: plan.fromSequence,
			toSequence: plan.toSequence,
			rowCount: plan.rowCount,
			firstOccurredAt: plan.firstOccurredAt!,
			lastOccurredAt: plan.lastOccurredAt!,
			segmentHash,
			previousAnchorHash: plan.previousAnchor?.anchorHash ?? null,
		});
		const sealedAt = this.#now();
		const anchorLine: SegmentAnchorLine = {
			kind: 'anchor',
			formatVersion: SEGMENT_FORMAT_VERSION,
			tenantId: request.tenantId,
			anchorSequence,
			fromSequence: plan.fromSequence,
			toSequence: plan.toSequence,
			rowCount: plan.rowCount,
			firstOccurredAt: plan.firstOccurredAt!,
			lastOccurredAt: plan.lastOccurredAt!,
			segmentHash,
			previousAnchorHash: plan.previousAnchor?.anchorHash ?? null,
			anchorHash,
			signature: this.#signer.sign(anchorHash),
			keyId: this.#signer.keyId,
			sealedBy: request.sealedBy,
			sealedAt,
		};
		const segmentPath = await this.#write(
			directory,
			segmentFile,
			request.tenantId,
			plan,
			anchorLine,
		);
		/* The file exists before the anchor is recorded: an anchor without its
		   segment would let retention remove links nothing holds, while a file
		   without an anchor is only a file the next seal rewrites. */
		const anchor = await this.#repository.insertAnchor({
			tenantId: request.tenantId,
			anchorSequence,
			fromSequence: plan.fromSequence,
			toSequence: plan.toSequence,
			rowCount: plan.rowCount,
			firstOccurredAt: plan.firstOccurredAt!,
			lastOccurredAt: plan.lastOccurredAt!,
			segmentHash,
			previousAnchorHash: plan.previousAnchor?.anchorHash ?? null,
			anchorHash,
			signature: anchorLine.signature,
			keyId: anchorLine.keyId,
			segmentFile,
			sealedBy: request.sealedBy,
			sealedAt,
		});
		await this.#repository.appendAuditEvent({
			tenantId: request.tenantId,
			actorId: request.sealedBy,
			action: AUDIT_EVENT_ACTIONS.chainSealed,
			subjectType: 'chain-anchor',
			subjectId: anchor.id,
			metadata: {
				anchorSequence,
				fromSequence: plan.fromSequence,
				toSequence: plan.toSequence,
				rowCount: plan.rowCount,
				segmentFile,
				keyId: anchorLine.keyId,
			},
			occurredAt: this.#now(),
		});
		return { applied: true, plan, segmentFile, segmentPath, anchor };
	}

	/**
	 * Verifies the segment files of a directory against the anchors the
	 * workspace recorded. It reads and never writes, so it is the same run with
	 * and without --apply.
	 *
	 * One pass reads the newest `filesPerVerify` files and the newest
	 * `filesPerVerify` anchors, and the report states that bound: a deployment
	 * that has sealed more than one window holds evidence this pass did not
	 * look at.
	 */
	async verify(request: {
		readonly tenantId: string;
		readonly inputDirectory: string;
	}): Promise<VerifyReport> {
		const directory = this.#directory(request.inputDirectory);
		/* One directory holds the segments of every workspace a deployment
		   sealed, so the name prefix is what selects this workspace's. A file of
		   another one is not this verification's to accept or reject. */
		const prefix = segmentNamePrefix(request.tenantId);
		const matching = (await readdir(directory))
			.filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl'))
			.sort();
		/* The name carries the zero-padded sequence range, so the sort is chain
		   order and the newest files are the last of it. The anchors are read
		   newest first, so taking the oldest files here would compare one end of
		   the directory against the other end of the chain. */
		const names = matching.slice(
			Math.max(0, matching.length - this.#verifyWindow),
		);
		const anchors = await this.#repository.listAnchors(
			request.tenantId,
			this.#verifyWindow,
		);
		const recorded = new Map(
			anchors.map((anchor) => [anchor.anchorSequence, anchor]),
		);
		const segments: SegmentVerification[] = [];
		const seen = new Map<number, SegmentAnchorLine>();
		for (const name of names) {
			segments.push(
				await this.#verifySegment(
					directory,
					name,
					request.tenantId,
					recorded,
					seen,
				),
			);
		}
		const chainFailures = chainFailuresOf(seen, recorded);
		const totals = segments.reduce(
			(sum, entry) => ({
				events: sum.events + entry.events,
				plaintextEvents: sum.plaintextEvents + entry.plaintextEvents,
			}),
			{ events: 0, plaintextEvents: 0 },
		);
		return {
			ok: segments.every((entry) => entry.ok) && chainFailures.length === 0,
			directory,
			segments,
			chain: {
				ok: chainFailures.length === 0,
				anchors: seen.size,
				failures: chainFailures,
			},
			totals,
			window: {
				limit: this.#verifyWindow,
				files: names.length,
				anchors: anchors.length,
				truncated:
					matching.length > names.length ||
					anchors.length >= this.#verifyWindow,
			},
		};
	}

	/** One file of this workspace's own name prefix, read once, start to end. */
	async #verifySegment(
		directory: string,
		name: string,
		tenantId: string,
		recorded: ReadonlyMap<number, AuditChainAnchor>,
		seen: Map<number, SegmentAnchorLine>,
	): Promise<SegmentVerification> {
		const failures: string[] = [];
		const path = resolve(directory, name);
		const stats = await stat(path);
		if (stats.size > SEAL_LIMITS.fileBytes) {
			return {
				file: name,
				ok: false,
				anchorSequence: null,
				fromSequence: null,
				toSequence: null,
				events: 0,
				plaintextEvents: 0,
				signatureKeyId: null,
				failures: [
					`${name} is larger than ${SEAL_LIMITS.fileBytes} bytes and was not read.`,
				],
			};
		}
		/* Read a line at a time: a segment may hold every event of a year and
		   verification has to stay a constant amount of memory. */
		let anchor: SegmentAnchorLine | null = null;
		let events = 0;
		let plaintextEvents = 0;
		let accumulator = '';
		let previousHash: string | null | undefined;
		let lineNumber = 0;
		const reader = createInterface({
			input: createReadStream(path, { encoding: 'utf8' }),
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		try {
			for await (const raw of reader) {
				lineNumber += 1;
				if (raw.trim() === '') continue;
				if (lineNumber === 1) {
					anchor = parseAnchorLine(raw);
					if (!anchor) break;
					accumulator = anchor.previousAnchorHash ?? '';
					previousHash = anchor.fromSequence > 1 ? undefined : null;
					continue;
				}
				if (failures.length > 0) break;
				const event = parseEventLine(raw);
				if (!event) {
					failures.push(`Line ${lineNumber} of ${name} is not an audit event.`);
					break;
				}
				if (storedAuditEventHash(event) !== event.eventHash) {
					failures.push(
						`Line ${lineNumber} of ${name} (sequence ${event.sequence}) does not match its own hash.`,
					);
					break;
				}
				if (previousHash !== undefined && event.previousHash !== previousHash) {
					failures.push(
						`Line ${lineNumber} of ${name} (sequence ${event.sequence}) does not link to the event before it.`,
					);
					break;
				}
				previousHash = event.eventHash;
				/* A row that names its format was written by a build that seals a
				   person's fields, so one without a sealed payload is an event
				   about nobody. Only a row from before the marker existed can be a
				   person left in the clear. */
				if (event.sealedPayload === null && !event.sealFormat) {
					plaintextEvents += 1;
				}
				accumulator = chainStep(accumulator, event.eventHash);
				events += 1;
			}
		} finally {
			reader.close();
		}
		if (!anchor) {
			return {
				file: name,
				ok: false,
				anchorSequence: null,
				fromSequence: null,
				toSequence: null,
				events: 0,
				plaintextEvents: 0,
				signatureKeyId: null,
				failures: [`${name} does not start with a segment anchor.`],
			};
		}
		/* Read after the whole file, because the anchor line is what names the
		   workspace. Another workspace's segments carry another name prefix and
		   were never opened here, so a file this pass did read and that names
		   somebody else is a rewritten anchor, not a foreign file. The anchor it
		   claims is also reported missing from the directory, which is what it
		   now is. */
		if (anchor.tenantId !== tenantId) {
			return {
				file: name,
				ok: false,
				anchorSequence: anchor.anchorSequence,
				fromSequence: anchor.fromSequence,
				toSequence: anchor.toSequence,
				events,
				plaintextEvents,
				signatureKeyId: anchor.keyId,
				failures: [
					...failures,
					`${name} is named after this workspace and its anchor names ${anchor.tenantId}.`,
				],
			};
		}
		if (failures.length === 0 && events !== anchor.rowCount) {
			failures.push(
				`${name} holds ${events} events and its anchor claims ${anchor.rowCount}.`,
			);
		}
		if (failures.length === 0 && accumulator !== anchor.segmentHash) {
			failures.push(`The segment hash of ${name} does not match its anchor.`);
		}
		const expectedAnchorHash = anchorHashOf(anchor);
		if (expectedAnchorHash !== anchor.anchorHash) {
			failures.push(`The anchor of ${name} does not match its own hash.`);
		}
		if (
			!this.#signer.verify(anchor.anchorHash, anchor.signature, anchor.keyId)
		) {
			failures.push(
				`The anchor signature of ${name} does not verify under key ${anchor.keyId}.`,
			);
		}
		const stored = recorded.get(anchor.anchorSequence);
		if (!stored) {
			failures.push(
				`The workspace records no anchor ${anchor.anchorSequence} for ${name}.`,
			);
		} else if (stored.anchorHash !== anchor.anchorHash) {
			failures.push(
				`The anchor of ${name} differs from the one the workspace recorded.`,
			);
		}
		if (seen.has(anchor.anchorSequence)) {
			failures.push(`Two segment files claim anchor ${anchor.anchorSequence}.`);
		} else {
			seen.set(anchor.anchorSequence, anchor);
		}
		return {
			file: name,
			ok: failures.length === 0,
			anchorSequence: anchor.anchorSequence,
			fromSequence: anchor.fromSequence,
			toSequence: anchor.toSequence,
			events,
			plaintextEvents,
			signatureKeyId: anchor.keyId,
			failures,
		};
	}

	async #write(
		directory: string,
		segmentFile: string,
		tenantId: string,
		plan: SealPlan,
		anchorLine: SegmentAnchorLine,
	): Promise<string> {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const path = resolve(directory, segmentFile);
		/* A previous run that died left a partial file at this name; it belonged
		   to no anchor, so it is this run's to replace. */
		await rm(path, { force: true });
		const handle = await open(path, 'wx', 0o600);
		try {
			await handle.write(`${JSON.stringify(anchorLine)}\n`);
			await this.#walk(
				tenantId,
				plan.previousAnchor?.toSequence ?? 0,
				async (event) => {
					if (event.sequence > plan.toSequence) return false;
					await handle.write(
						`${JSON.stringify({ kind: 'event', ...event })}\n`,
					);
					return true;
				},
			);
			await handle.close();
			return path;
		} catch (error) {
			/* A segment is complete or it does not exist: a half-written file
			   would be read as the workspace's evidence. */
			await handle.close().catch(() => undefined);
			await rm(path, { force: true });
			throw error;
		}
	}

	/** Answers false when `visit` stopped the walk before the last event. */
	async #walk(
		tenantId: string,
		afterSequence: number,
		visit: (event: StoredAuditEvent) => boolean | Promise<boolean>,
	): Promise<boolean> {
		let cursor = afterSequence;
		for (;;) {
			const page = await this.#repository.sealAuditEventsPage(
				tenantId,
				cursor,
				SEAL_LIMITS.page,
			);
			for (const event of page) {
				cursor = event.sequence;
				if (!(await visit(event))) return false;
			}
			if (page.length < SEAL_LIMITS.page) return true;
		}
	}

	#directory(requested: string): string {
		return exportOutputDirectory({
			environment: this.#environment,
			workspaceRoot: this.#workspaceRoot,
			requested,
		});
	}
}

function chainFailuresOf(
	seen: ReadonlyMap<number, SegmentAnchorLine>,
	recorded: ReadonlyMap<number, AuditChainAnchor>,
): readonly string[] {
	const failures: string[] = [];
	const ordered = [...seen.keys()].sort((left, right) => left - right);
	let previous: SegmentAnchorLine | null = null;
	for (const sequence of ordered) {
		const anchor = seen.get(sequence)!;
		const expected = previous?.anchorHash ?? null;
		/* The first anchor a directory holds need not be anchor one: an operator
		   may verify a directory that carries only the newest segments, and the
		   recorded anchors are what prove the anchors before it existed. */
		if (previous && anchor.previousAnchorHash !== expected) {
			failures.push(
				`Anchor ${sequence} does not link to anchor ${previous.anchorSequence}.`,
			);
		}
		if (previous && anchor.anchorSequence !== previous.anchorSequence + 1) {
			failures.push(
				`Anchor ${sequence} follows anchor ${previous.anchorSequence}, so a segment is missing from this directory.`,
			);
		}
		if (previous && anchor.fromSequence !== previous.toSequence + 1) {
			failures.push(
				`Anchor ${sequence} starts at sequence ${anchor.fromSequence} and anchor ${previous.anchorSequence} ended at ${previous.toSequence}.`,
			);
		}
		previous = anchor;
	}
	if (ordered.length === 0) {
		if (recorded.size > 0) {
			failures.push(
				`This workspace records ${recorded.size} anchors and the directory holds no segment for any of them.`,
			);
		}
		return failures;
	}
	/* A directory may begin above anchor one, because an operator may verify one
	   holding only the newest segments. It may not end below the newest recorded
	   anchor and it may not skip one inside the range it does hold: either is a
	   segment file that is gone, which the links between the files it still
	   holds cannot show. */
	const lowest = ordered[0]!;
	for (const sequence of [...recorded.keys()].sort(
		(left, right) => left - right,
	)) {
		if (sequence < lowest || seen.has(sequence)) continue;
		failures.push(
			`This workspace records anchor ${sequence} and the directory holds no segment for it.`,
		);
	}
	return failures;
}

function parseAnchorLine(line: string): SegmentAnchorLine | null {
	try {
		const parsed = JSON.parse(line) as SegmentAnchorLine;
		return parsed?.kind === 'anchor' &&
			parsed.formatVersion === SEGMENT_FORMAT_VERSION &&
			typeof parsed.anchorHash === 'string' &&
			typeof parsed.segmentHash === 'string' &&
			typeof parsed.signature === 'string' &&
			typeof parsed.keyId === 'string' &&
			Number.isSafeInteger(parsed.anchorSequence) &&
			Number.isSafeInteger(parsed.fromSequence) &&
			Number.isSafeInteger(parsed.toSequence) &&
			Number.isSafeInteger(parsed.rowCount)
			? parsed
			: null;
	} catch {
		return null;
	}
}

function parseEventLine(line: string): StoredAuditEvent | null {
	try {
		const parsed = JSON.parse(line) as SegmentEventLine;
		return parsed?.kind === 'event' &&
			typeof parsed.id === 'string' &&
			typeof parsed.eventHash === 'string' &&
			Number.isSafeInteger(parsed.sequence)
			? parsed
			: null;
	} catch {
		return null;
	}
}

/**
 * What every segment file of one workspace is named after. The trailing
 * separator is load bearing: without it the prefix of one workspace would also
 * select the files of another whose id starts with the same characters.
 */
export function segmentNamePrefix(tenantId: string): string {
	return `audit-segment-${tenantId.replaceAll(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)}-`;
}

/* The sequence range is part of the name, so a directory listing reads as the
   chain it holds and two segments can never collide. */
function segmentName(tenantId: string, from: number, to: number): string {
	const pad = (value: number) => String(value).padStart(12, '0');
	return `${segmentNamePrefix(tenantId)}${pad(from)}-${pad(to)}.jsonl`;
}
