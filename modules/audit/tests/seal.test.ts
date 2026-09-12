import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	createDataClassRegistry,
	KEYRING_MAX_PREVIOUS_KEYS,
} from '@flowdular/kernel';
import { AUDIT_EVENT_ACTIONS, AUDIT_REASONS } from '../src/domain/types.ts';
import {
	auditEventHash,
	stableMetadata,
} from '../src/services/database-repository.ts';
import { createAnchorSigner } from '../src/services/anchor-key.ts';
import { rotateAnchorSignatures } from '../src/services/anchor-rotation.ts';
import { AuditHoldService } from '../src/services/hold-service.ts';
import { AuditRetentionService } from '../src/services/retention-service.ts';
import { AuditSealService } from '../src/services/seal-service.ts';
import { AuditSweepService } from '../src/services/sweep-service.ts';
import { auditOwnDataClasses } from '../src/services/own-classes.ts';
import {
	openAuditTestDatabase,
	type AuditTestDatabase,
} from './support/database.ts';
import { backupPresent } from './support/fake-modules.ts';
import {
	openOperatorDirectory,
	type OperatorDirectory,
} from './support/operator.ts';

const ALPHA = 'tenant-alpha';
const BETA = 'tenant-beta';
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const DAY = 86_400_000;
const CURRENT_KEY = Buffer.alloc(32, 0x41);
const RETIRED_KEY = Buffer.alloc(32, 0x42);

let shared: AuditTestDatabase;
let operator: OperatorDirectory;

beforeAll(async () => {
	shared = await openAuditTestDatabase();
	operator = await openOperatorDirectory();
});

afterAll(async () => {
	await shared?.dispose();
	await operator?.cleanup();
});

afterEach(async () => {
	await shared.reset();
	for (const name of await readdir(operator.allowed)) {
		await rm(resolve(operator.allowed, name), { force: true });
	}
});

function sealService(signer = createAnchorSigner(CURRENT_KEY)) {
	return new AuditSealService({
		repository: shared.repository,
		signer,
		environment: operator.environment,
		workspaceRoot: operator.workspaceRoot,
		now: () => NOW,
	});
}

async function writeEvents(count: number, from = 0): Promise<void> {
	for (let index = from; index < from + count; index += 1) {
		await shared.repository.appendAuditEvent({
			tenantId: ALPHA,
			actorId: 'audit.core',
			action: AUDIT_EVENT_ACTIONS.retentionSweep,
			subjectType: 'data-class',
			subjectId: `agents.core.runs-${index}`,
			metadata: { index },
			occurredAt: NOW - (100 - index) * DAY,
		});
	}
}

async function writeEventsFor(tenantId: string, count: number): Promise<void> {
	for (let index = 0; index < count; index += 1) {
		await shared.repository.appendAuditEvent({
			tenantId,
			actorId: 'audit.core',
			action: AUDIT_EVENT_ACTIONS.retentionSweep,
			subjectType: 'data-class',
			subjectId: `agents.core.runs-${index}`,
			metadata: { index },
			occurredAt: NOW - (100 - index) * DAY,
		});
	}
}

/**
 * A row as a build before the event format marker wrote it: no marker, no
 * sealed payload, and a hash over exactly those bytes. Inserted rather than
 * appended, because the repository only writes rows that name their format.
 */
async function writeLegacyEvent(): Promise<void> {
	const previous = (await shared.repository.listAuditEvents(ALPHA, 1))[0];
	const event = {
		id: '00000000-0000-4000-8000-00000000beef',
		tenantId: ALPHA,
		sequence: (previous?.sequence ?? 0) + 1,
		actorId: 'account-bob',
		action: AUDIT_EVENT_ACTIONS.retentionSet,
		subjectType: 'data-class',
		subjectId: 'agents.core.runs',
		metadataJson: stableMetadata({ email: 'bob@example.com' }),
		occurredAt: NOW,
		previousHash: previous?.eventHash ?? null,
		sealed: false,
		subjectKeyId: null,
		sealFormat: null,
	};
	await shared.runtime.transaction(
		(transaction) =>
			transaction.execute({
				text: `INSERT INTO audit_events
				 (id, tenant_id, sequence, actor_id, action, subject_type, subject_id,
				  metadata_json, occurred_at, previous_hash, event_hash, subject_key_id,
				  sealed_payload, seal_format)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, NULL, NULL)`,
				parameters: [
					event.id,
					event.tenantId,
					event.sequence,
					event.actorId,
					event.action,
					event.subjectType,
					event.subjectId,
					event.metadataJson,
					event.occurredAt,
					event.previousHash,
					auditEventHash(event),
				],
			}),
		{ access: 'write', tenantId: ALPHA },
	);
}

async function segments(): Promise<readonly string[]> {
	return (await readdir(operator.allowed))
		.filter((name) => name.endsWith('.jsonl'))
		.sort();
}

describe('AUDIT-SEAL-DRY-RUN', () => {
	it('names the range and the file it would write and writes nothing', async () => {
		await writeEvents(3);
		const seals = sealService();

		const result = await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: false,
		});

		expect({
			applied: result.applied,
			from: result.plan.fromSequence,
			to: result.plan.toSequence,
			rows: result.plan.rowCount,
			anchor: result.anchor,
		}).toEqual({ applied: false, from: 1, to: 3, rows: 3, anchor: null });
		expect(await segments()).toEqual([]);
		expect(await shared.repository.latestAnchor(ALPHA)).toBeNull();
	});
});

describe('AUDIT-SEAL-CHAIN', () => {
	it('continues the chain across two segments and verifies both', async () => {
		const seals = sealService();
		await writeEvents(3);
		const first = await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		await writeEvents(2, 3);
		const second = await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});

		/* The sealing event of the first run is itself an event, so the second
		   segment carries the two new events plus that link. */
		expect(second.anchor?.previousAnchorHash).toBe(first.anchor?.anchorHash);
		expect(second.anchor?.fromSequence).toBe(
			(first.anchor?.toSequence ?? 0) + 1,
		);
		expect(second.anchor?.anchorSequence).toBe(2);
		expect((await segments()).length).toBe(2);

		const report = await seals.verify({
			tenantId: ALPHA,
			inputDirectory: operator.allowed,
		});
		expect({
			ok: report.ok,
			anchors: report.chain.anchors,
			failures: report.chain.failures,
		}).toEqual({ ok: true, anchors: 2, failures: [] });
		expect(report.segments.map((entry) => entry.ok)).toEqual([true, true]);
	});

	/* Sealing writes an event of its own, so the segment after a seal always
	   holds at least that link; only a workspace whose chain is empty has
	   nothing to close. */
	it('refuses a seal on a workspace whose chain is empty', async () => {
		await expect(
			sealService().seal({
				tenantId: ALPHA,
				outputDirectory: operator.allowed,
				sealedBy: 'cli:ada',
				apply: false,
			}),
		).rejects.toMatchObject({ code: 'NOTHING_TO_SEAL' });
	});
});

describe('AUDIT-SEAL-TAMPER', () => {
	it('names the edited line and refuses the segment', async () => {
		const seals = sealService();
		await writeEvents(3);
		const sealed = await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		const path = sealed.segmentPath!;
		const lines = (await readFile(path, 'utf8')).split('\n');
		const event = JSON.parse(lines[2]!) as { metadataJson: string };
		lines[2] = JSON.stringify({ ...event, metadataJson: '{"index":999}' });
		await writeFile(path, lines.join('\n'));

		const report = await seals.verify({
			tenantId: ALPHA,
			inputDirectory: operator.allowed,
		});

		expect(report.ok).toBe(false);
		expect(report.segments[0]?.failures.join(' ')).toContain('Line 3');
		expect(report.segments[0]?.failures.join(' ')).toContain(
			'does not match its own hash',
		);
	});

	it('refuses a segment whose anchor signature was forged', async () => {
		const seals = sealService();
		await writeEvents(2);
		const sealed = await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		const path = sealed.segmentPath!;
		const lines = (await readFile(path, 'utf8')).split('\n');
		const anchor = JSON.parse(lines[0]!) as { signature: string };
		lines[0] = JSON.stringify({ ...anchor, signature: 'a'.repeat(64) });
		await writeFile(path, lines.join('\n'));

		const report = await seals.verify({
			tenantId: ALPHA,
			inputDirectory: operator.allowed,
		});

		expect(report.ok).toBe(false);
		expect(report.segments[0]?.failures.join(' ')).toContain(
			'anchor signature',
		);
	});
});

describe('AUDIT-SEAL-ROTATE', () => {
	it('re-signs anchors under the current key and leaves the segments verifiable', async () => {
		const retired = createAnchorSigner(RETIRED_KEY);
		await writeEvents(3);
		await sealService(retired).seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		const rotated = createAnchorSigner(CURRENT_KEY, [RETIRED_KEY]);

		const planned = await rotateAnchorSignatures({
			repository: shared.repository,
			signer: rotated,
		});
		expect({ stale: planned.stale, rotated: planned.rotated }).toEqual({
			stale: 1,
			rotated: 0,
		});

		const applied = await rotateAnchorSignatures({
			repository: shared.repository,
			signer: rotated,
			apply: true,
		});
		expect({
			rotated: applied.rotated,
			skipped: applied.skipped,
			unknown: applied.unknownKeys,
		}).toEqual({ rotated: 1, skipped: 0, unknown: [] });

		const anchor = await shared.repository.latestAnchor(ALPHA);
		expect(anchor?.keyId).toBe(rotated.keyId);
		expect(
			rotated.verify(anchor!.anchorHash, anchor!.signature, anchor!.keyId),
		).toBe(true);

		/* The file on disk still carries the retired signature, and the ring that
		   holds both keys still accepts it. */
		const report = await sealService(rotated).verify({
			tenantId: ALPHA,
			inputDirectory: operator.allowed,
		});
		expect(report.ok).toBe(true);

		const second = await rotateAnchorSignatures({
			repository: shared.repository,
			signer: rotated,
			apply: true,
		});
		expect({ stale: second.stale, rotated: second.rotated }).toEqual({
			stale: 0,
			rotated: 0,
		});
	});
});

describe('AUDIT-SWEEP-SEALED', () => {
	async function sweepFixture(holds?: AuditHoldService) {
		const registry = createDataClassRegistry();
		registry.declare(
			'audit.core',
			auditOwnDataClasses(async () => shared.repository),
		);
		const retention = new AuditRetentionService(
			shared.repository,
			registry,
			() => NOW,
		);
		const sweep = new AuditSweepService({
			repository: shared.repository,
			registry,
			backup: backupPresent(),
			batchSize: () => 100,
			intervalMs: () => 60 * 60_000,
			now: () => NOW,
			...(holds ? { holds: (input) => holds.forClass(input) } : {}),
		});
		await retention.setRetention(ALPHA, 'account-ada', {
			classId: 'audit.core.events',
			mode: 'days',
			days: 30,
		});
		return { sweep };
	}

	it('refuses to remove an event no segment file holds', async () => {
		await writeEvents(3);
		const { sweep } = await sweepFixture();

		await sweep.tick();

		/* The two ledgers audit.core keeps about itself are swept on the same
		   pass, so the run this case is about is selected by its class. */
		const run = (
			await shared.repository.listSweepRuns(ALPHA, undefined, 10)
		).find((entry) => entry.classId === 'audit.core.events');
		expect([run?.status, run?.reason, run?.removed]).toEqual([
			'refused',
			AUDIT_REASONS.segmentNotSealed,
			0,
		]);
		expect(
			(await shared.repository.listAuditEvents(ALPHA, 50)).length,
		).toBeGreaterThanOrEqual(3);
	});

	it('counts the rows a hold withheld for the class audit.core owns', async () => {
		await writeEvents(3);
		const holds = new AuditHoldService(shared.repository, () => NOW);
		await holds.place(ALPHA, 'account-ada', {
			scopeKind: 'data-class',
			classId: 'audit.core.events',
			reason: 'Pending litigation.',
		});
		const { sweep } = await sweepFixture(holds);

		await sweep.tick();

		const run = (
			await shared.repository.listSweepRuns(ALPHA, undefined, 10)
		).find((entry) => entry.classId === 'audit.core.events');
		expect([run?.status, run?.reason]).toEqual([
			'refused',
			AUDIT_REASONS.holdActive,
		]);
		/* audit.core owns this class, so the ledger carries the exact count of
		   the events the hold withheld rather than leaving it absent. */
		expect(run?.heldBack).toBe(
			await shared.repository.countAuditEventsBefore(
				ALPHA,
				NOW - 30 * DAY,
				null,
			),
		);
		expect(run?.heldBack).toBeGreaterThan(0);
	});

	it('removes sealed events once a segment file holds them', async () => {
		await writeEvents(3);
		await sealService().seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		const sealedThrough =
			(await shared.repository.latestAnchor(ALPHA))?.toSequence ?? 0;
		const { sweep } = await sweepFixture();

		await sweep.tick();

		const remaining = await shared.repository.listAuditEvents(ALPHA, 50);
		expect(
			remaining.filter(
				(event) =>
					event.sequence <= sealedThrough && event.occurredAt < NOW - 30 * DAY,
			),
		).toEqual([]);
	});
});

describe('verification boundaries', () => {
	/* One operator directory holds the segments of every workspace a deployment
	   sealed. A verification of one workspace reads its own files and leaves the
	   others alone; before the name filter it read all of them and failed on
	   every anchor that belonged to somebody else. */
	it('verifies each workspace of a directory two workspaces were sealed into', async () => {
		const seals = sealService();
		await writeEvents(3);
		await writeEventsFor(BETA, 2);
		await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		await seals.seal({
			tenantId: BETA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		expect((await segments()).length).toBe(2);

		for (const tenantId of [ALPHA, BETA]) {
			const report = await seals.verify({
				tenantId,
				inputDirectory: operator.allowed,
			});
			expect([tenantId, report.ok, report.segments.length]).toEqual([
				tenantId,
				true,
				1,
			]);
			expect(report.chain.failures).toEqual([]);
		}
	});

	/* The identifier of the key a sealed row points at is part of the row's
	   hash. Repointing it at another subject key would otherwise leave the hash
	   matching, and destroying the original key would no longer reach the row. */
	it('refuses a sealed line whose subject key was repointed', async () => {
		const seals = sealService();
		await shared.repository.appendAuditEvent({
			tenantId: ALPHA,
			actorId: 'account-bob',
			action: AUDIT_EVENT_ACTIONS.retentionSet,
			subjectType: 'data-class',
			subjectId: 'agents.core.runs',
			metadata: { email: 'bob@example.com' },
			occurredAt: NOW,
			subjectAccountId: 'account-bob',
		});
		const sealed = await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		const path = sealed.segmentPath!;
		const lines = (await readFile(path, 'utf8')).split('\n');
		const event = JSON.parse(lines[1]!) as { subjectKeyId: string };
		expect(event.subjectKeyId).not.toBeNull();
		lines[1] = JSON.stringify({
			...event,
			subjectKeyId: '00000000-0000-4000-8000-000000000000',
		});
		await writeFile(path, lines.join('\n'));

		const report = await seals.verify({
			tenantId: ALPHA,
			inputDirectory: operator.allowed,
		});

		expect(report.ok).toBe(false);
		expect(report.segments[0]?.failures.join(' ')).toContain(
			'does not match its own hash',
		);
	});

	/* An event about nobody carries no sealed payload and is not a person left
	   in the clear. Only a row written before audit.core recorded a format is. */
	it('counts only rows written before the event format as plaintext', async () => {
		const seals = sealService();
		await writeEvents(2);
		await writeLegacyEvent();
		await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});

		const report = await seals.verify({
			tenantId: ALPHA,
			inputDirectory: operator.allowed,
		});

		expect(report.ok).toBe(true);
		expect(report.totals.events).toBeGreaterThan(2);
		expect(report.totals.plaintextEvents).toBe(1);
	});

	/* The name prefix is what selects a workspace's segments. A file dropped
	   into the directory under any other name is not evidence this workspace
	   sealed, whatever its content claims. */
	it('reads no file of the directory that is not named after the workspace', async () => {
		const seals = sealService();
		await writeEvents(3);
		await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		await writeFile(
			resolve(operator.allowed, 'planted-segment.jsonl'),
			`${JSON.stringify({
				kind: 'anchor',
				formatVersion: 'audit-segment/1',
				tenantId: ALPHA,
				anchorSequence: 9,
				fromSequence: 1,
				toSequence: 1,
				rowCount: 0,
				firstOccurredAt: NOW,
				lastOccurredAt: NOW,
				segmentHash: 'planted',
				previousAnchorHash: null,
				anchorHash: 'planted',
				signature: 'planted',
				keyId: 'planted',
				sealedBy: 'planted',
				sealedAt: NOW,
			})}\n`,
		);
		await writeFile(resolve(operator.allowed, 'notes.txt'), 'not a segment');

		const report = await seals.verify({
			tenantId: ALPHA,
			inputDirectory: operator.allowed,
		});

		expect(report.ok).toBe(true);
		expect(report.segments.length).toBe(1);
		expect(report.window.files).toBe(1);
	});
});

describe('AUDIT-SEAL-SEGMENT-MISSING', () => {
	/* The links between the files a directory still holds say nothing about a
	   file that is gone, so the recorded anchors are what the directory is
	   answerable to. Deleting the newest segment passed verification. */
	it('fails when the newest segment file of the workspace is gone', async () => {
		const seals = sealService();
		await writeEvents(3);
		await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		await writeEvents(2, 3);
		const second = await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		await rm(second.segmentPath!);

		const report = await seals.verify({
			tenantId: ALPHA,
			inputDirectory: operator.allowed,
		});

		expect(report.ok).toBe(false);
		expect(report.chain.failures.join(' ')).toContain(
			'records anchor 2 and the directory holds no segment for it',
		);
		/* The segment that is still there is untouched and still verifies. */
		expect(report.segments.map((entry) => entry.ok)).toEqual([true]);
	});

	/* A file carrying this workspace's name prefix was read by this pass, so an
	   anchor in it naming somebody else is a rewritten segment. Skipping it as
	   another workspace's file let a segment be removed from the evidence by
	   editing one field. */
	it('fails a segment named after this workspace whose anchor names another', async () => {
		const seals = sealService();
		await writeEvents(3);
		const first = await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		await writeEvents(2, 3);
		await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		const path = first.segmentPath!;
		const lines = (await readFile(path, 'utf8')).split('\n');
		const anchor = JSON.parse(lines[0]!) as { tenantId: string };
		lines[0] = JSON.stringify({ ...anchor, tenantId: BETA });
		await writeFile(path, lines.join('\n'));

		const report = await seals.verify({
			tenantId: ALPHA,
			inputDirectory: operator.allowed,
		});

		expect(report.ok).toBe(false);
		expect(report.segments.map((entry) => entry.ok)).toEqual([false, true]);
		expect(report.segments[0]?.failures.join(' ')).toContain(
			`is named after this workspace and its anchor names ${BETA}`,
		);
	});
});

describe('AUDIT-SEAL-VERIFY-WINDOW', () => {
	/* The file names carry the zero-padded sequence range and the anchors are
	   read newest first, so both windows have to take the same end. Taking the
	   oldest files and the newest anchors reported every file as unrecorded. */
	it('reads the newest files and the newest anchors when a directory holds more than one window', async () => {
		const seals = new AuditSealService({
			repository: shared.repository,
			signer: createAnchorSigner(CURRENT_KEY),
			environment: operator.environment,
			workspaceRoot: operator.workspaceRoot,
			now: () => NOW,
			verifyWindow: 1,
		});
		await writeEvents(3);
		await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		await writeEvents(2, 3);
		const second = await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		expect((await segments()).length).toBe(2);

		const report = await seals.verify({
			tenantId: ALPHA,
			inputDirectory: operator.allowed,
		});

		expect(report.ok).toBe(true);
		expect(report.segments.map((entry) => entry.file)).toEqual([
			second.segmentFile,
		]);
		expect(report.window).toEqual({
			limit: 1,
			files: 1,
			anchors: 1,
			truncated: true,
		});
	});
});

/* The hash is the evidence, so what it is taken over is pinned here rather
   than read from the implementation: this digest is built from the thirteen
   documented fields, in order, by code that shares nothing with the module. */
describe('AUDIT-EVENT-HASH-PREIMAGE', () => {
	it('covers exactly the thirteen stored fields, in the documented order', async () => {
		await shared.repository.appendAuditEvent({
			tenantId: ALPHA,
			actorId: 'account-bob',
			action: AUDIT_EVENT_ACTIONS.retentionSet,
			subjectType: 'data-class',
			subjectId: 'agents.core.runs',
			metadata: { email: 'bob@example.com' },
			occurredAt: NOW,
			subjectAccountId: 'account-bob',
		});
		const [stored] = await shared.repository.sealAuditEventsPage(ALPHA, 0, 10);

		const preimage = JSON.stringify([
			stored!.id,
			stored!.tenantId,
			stored!.sequence,
			stored!.actorId,
			stored!.action,
			stored!.subjectType,
			stored!.subjectId,
			stored!.sealedPayload ?? stored!.metadataJson,
			stored!.occurredAt,
			stored!.previousHash,
			stored!.sealedPayload !== null,
			stored!.subjectKeyId,
			stored!.sealFormat,
		]);

		expect(stored!.sealedPayload).not.toBeNull();
		expect(createHash('sha256').update(preimage).digest('hex')).toBe(
			stored!.eventHash,
		);
	});
});

describe('anchor rotation', () => {
	/* A signature that does not verify is evidence. Signing the anchor hash
	   again would replace it with one this deployment vouches for, so the run
	   reports the anchor and leaves it exactly as it is. */
	it('reports an anchor whose stored signature does not verify and never re-signs it', async () => {
		await writeEvents(2);
		await sealService(createAnchorSigner(RETIRED_KEY)).seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		const anchor = (await shared.repository.latestAnchor(ALPHA))!;
		await shared.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: `UPDATE audit_anchors SET signature = $2 WHERE id = $1`,
					parameters: [anchor.id, 'f'.repeat(64)],
				}),
			{ access: 'write', tenantId: ALPHA },
		);
		const rotated = createAnchorSigner(CURRENT_KEY, [RETIRED_KEY]);

		const report = await rotateAnchorSignatures({
			repository: shared.repository,
			signer: rotated,
			apply: true,
		});

		expect({
			rotated: report.rotated,
			unverified: report.unverified,
			unverifiedCount: report.unverifiedCount,
		}).toEqual({ rotated: 0, unverified: [anchor.id], unverifiedCount: 1 });
		const stored = await shared.repository.latestAnchor(ALPHA);
		expect([stored?.signature, stored?.keyId]).toEqual([
			'f'.repeat(64),
			anchor.keyId,
		]);
	});

	it('reports an anchor signed under a key no ring holds without rotating it', async () => {
		await writeEvents(2);
		await sealService(createAnchorSigner(RETIRED_KEY)).seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});
		const anchor = (await shared.repository.latestAnchor(ALPHA))!;

		const report = await rotateAnchorSignatures({
			repository: shared.repository,
			signer: createAnchorSigner(CURRENT_KEY),
			apply: true,
		});

		expect({
			rotated: report.rotated,
			unknownKeys: report.unknownKeys,
			unverifiedCount: report.unverifiedCount,
		}).toEqual({ rotated: 0, unknownKeys: [anchor.keyId], unverifiedCount: 1 });
		expect((await shared.repository.latestAnchor(ALPHA))?.keyId).toBe(
			anchor.keyId,
		);
	});
});

describe('anchor key ring', () => {
	/* The same bound the kernel keyring enforces: a longer ring means a rotation
	   was never finished and every retired key still vouches for a segment. */
	it('refuses more retired keys than the keyring accepts', () => {
		const retired = Array.from(
			{ length: KEYRING_MAX_PREVIOUS_KEYS },
			(_, index) => Buffer.alloc(32, index + 1),
		);

		expect(() => createAnchorSigner(CURRENT_KEY, retired)).not.toThrow();
		expect(() =>
			createAnchorSigner(CURRENT_KEY, [...retired, Buffer.alloc(32, 0x7f)]),
		).toThrow(/at most 8 retired keys/);
	});
});
