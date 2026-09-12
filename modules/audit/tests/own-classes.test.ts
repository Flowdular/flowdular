import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	createDataClassRegistry,
	type DataClassDeclaration,
	type DataClassExportSummary,
} from '@flowdular/kernel';
import { AUDIT_EVENT_ACTIONS } from '../src/domain/types.ts';
import {
	AUDIT_DEFAULT_RETENTION_DAYS,
	auditOwnDataClasses,
} from '../src/services/own-classes.ts';
import { AuditRetentionService } from '../src/services/retention-service.ts';
import {
	AUDIT_TENANT_TABLES,
	openAuditTestDatabase,
	type AuditTestDatabase,
} from './support/database.ts';

const ALPHA = 'tenant-alpha';
const BETA = 'tenant-beta';
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const DAY = 86_400_000;

let shared: AuditTestDatabase;

beforeAll(async () => {
	shared = await openAuditTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

function declarations() {
	return auditOwnDataClasses(async () => shared.repository);
}

async function seedLedgers(tenantId: string, at: number): Promise<void> {
	await shared.repository.appendSweepRun({
		tenantId,
		classId: 'agents.core.runs',
		cutoff: at,
		removed: 1,
		status: 'completed',
		reason: null,
		heldBack: null,
		occurredAt: at,
	});
	const run = await shared.repository.startExportRun({
		tenantId,
		formatVersion: 'audit-export/1',
		requestedBy: 'cli:ada',
		outputDirectory: '/var/exports',
		dryRun: false,
		workspaceSlug: tenantId,
		workspaceName: tenantId,
		startedAt: at,
	});
	await shared.repository.finishExportRun({
		tenantId,
		id: run.id,
		status: 'completed',
		classes: 1,
		rows: 1,
		archiveDigest: 'digest',
		archivePath: '/var/exports/archive.zip',
		reason: null,
		summary: null,
		completedAt: at,
	});
}

/**
 * Every tenant table audit.core owns, and the class key that carries it. Null
 * is a table that is deliberately not a class, with the reason beside it.
 */
const TABLE_CLASS_KEYS: Readonly<Record<string, string | null>> = {
	audit_events: 'events',
	audit_sweep_runs: 'sweep-runs',
	audit_export_runs: 'export-runs',
	audit_legal_holds: 'legal-holds',
	audit_erasure_runs: 'erasure-runs',
	audit_anchors: 'anchors',
	audit_subject_keys: 'subject-keys',
	/* The registry's own projection: one row per declared class, rebuilt from
	   the declarations and carrying the workspace's chosen period. It is the
	   catalogue the screen reads, not data the workspace accumulated. */
	audit_data_classes: null,
};

async function seedHoldAndErasure(tenantId: string): Promise<void> {
	await shared.repository.insertHold({
		tenantId,
		scopeKind: 'account',
		accountId: 'account-bob',
		classId: null,
		fromAt: null,
		toAt: null,
		reason: 'Matter 42',
		placedBy: 'account-ada',
		placedAt: NOW,
	});
	const run = await shared.repository.startErasureRun({
		tenantId,
		subject: 'account-bob',
		subjectMarker: 'marker-bob',
		requestedBy: 'cli:ada',
		outputDirectory: '/var/exports',
		dryRun: false,
		destroyKey: false,
		workspaceSlug: tenantId,
		workspaceName: tenantId,
		startedAt: NOW,
	});
	await shared.repository.finishErasureRun({
		tenantId,
		id: run.id,
		status: 'completed',
		classes: 1,
		rows: 0,
		certificatePath: '/var/exports/certificate.json',
		outcome: null,
		reason: null,
		completedAt: NOW,
	});
}

/** One class exported through its own declaration, as the archive sees it. */
async function collect(
	declaration: DataClassDeclaration,
	tenantId: string,
): Promise<{
	readonly rows: readonly Record<string, unknown>[];
	readonly summary: DataClassExportSummary;
}> {
	const rows: Record<string, unknown>[] = [];
	const summary = await declaration.export!({
		tenantId,
		sink: {
			write: async (row) => {
				rows.push(row);
			},
		},
	});
	return { rows, summary };
}

describe('audit.core data classes', () => {
	/* D-AUDIT-RETENTION-DEFAULTS: audit events are kept 400 days, and so are the
	   two ledgers about them. A class declared with no default was kept for ever
	   and the ledgers grew without a bound. */
	it('declares 400 days for the chain and both ledgers', () => {
		/* The literal, not the constant the code reads: a period this test took
		   from the implementation would agree with whatever the implementation
		   said. D-AUDIT-RETENTION-DEFAULTS is what fixes it at 400. */
		expect(
			declarations().map((entry) => [
				entry.key,
				entry.defaultRetentionDays,
				typeof entry.sweep,
			]),
		).toEqual([
			['events', 400, 'function'],
			['sweep-runs', 400, 'function'],
			['export-runs', 400, 'function'],
			/* The four below are kept until a person deletes them: a hold, an
			   erasure record, an anchor and a subject key are each evidence or
			   integrity material that no period may take away. */
			['legal-holds', null, 'undefined'],
			['erasure-runs', null, 'undefined'],
			['anchors', null, 'undefined'],
			['subject-keys', null, 'undefined'],
		]);
		expect(AUDIT_DEFAULT_RETENTION_DAYS).toBe(400);
	});

	it('ages both ledgers on the period and leaves another workspace alone', async () => {
		const old = NOW - 500 * DAY;
		await seedLedgers(ALPHA, old);
		await seedLedgers(ALPHA, NOW);
		await seedLedgers(BETA, old);
		const [, sweepRuns, exportRuns] = declarations();

		const swept = await sweepRuns!.sweep!({
			tenantId: ALPHA,
			cutoff: new Date(NOW - AUDIT_DEFAULT_RETENTION_DAYS * DAY),
			limit: 100,
		});
		const exported = await exportRuns!.sweep!({
			tenantId: ALPHA,
			cutoff: new Date(NOW - AUDIT_DEFAULT_RETENTION_DAYS * DAY),
			limit: 100,
		});

		expect([swept.removed, exported.removed]).toEqual([1, 1]);
		expect(
			(await shared.repository.listSweepRuns(ALPHA, undefined, 10)).map(
				(run) => run.occurredAt,
			),
		).toEqual([NOW]);
		expect(
			(await shared.repository.listExportRuns(ALPHA, undefined, 10)).map(
				(run) => run.startedAt,
			),
		).toEqual([NOW]);
		expect(
			await shared.repository.listSweepRuns(BETA, undefined, 10),
		).toHaveLength(1);
		expect(
			await shared.repository.listExportRuns(BETA, undefined, 10),
		).toHaveLength(1);
	});

	/* A run the platform has not answered is what a waiting command is polling,
	   so age alone must never take it. */
	it('never removes an export run the platform has not answered', async () => {
		await shared.repository.startExportRun({
			tenantId: ALPHA,
			formatVersion: 'audit-export/1',
			requestedBy: 'cli:ada',
			outputDirectory: '/var/exports',
			dryRun: false,
			workspaceSlug: 'alpha',
			workspaceName: 'Alpha',
			startedAt: NOW - 500 * DAY,
		});
		const [, , exportRuns] = declarations();

		const removed = await exportRuns!.sweep!({
			tenantId: ALPHA,
			cutoff: new Date(NOW - AUDIT_DEFAULT_RETENTION_DAYS * DAY),
			limit: 100,
		});

		expect(removed.removed).toBe(0);
		expect(
			(await shared.repository.listExportRuns(ALPHA, undefined, 10)).map(
				(run) => run.status,
			),
		).toEqual(['started']);
	});

	describe('AUDIT-OWN-CLASS-CATALOGUE', () => {
		/* The catalogue a workspace reads has to be the deployment, not the part of
		   it that happens to be swept. A tenant table that is neither declared nor
		   named here is a class the workspace can never see, export or account for. */
		it('declares a class for every tenant table it owns', () => {
			const declared = declarations().map((entry) => entry.key);

			const expected = AUDIT_TENANT_TABLES.flatMap((table) => {
				const key = TABLE_CLASS_KEYS[table];
				if (key === undefined) {
					throw new Error(
						`${table} is neither declared as a data class nor recorded here as one that is deliberately not.`,
					);
				}
				return key === null ? [] : [key];
			});
			expect([...declared].sort()).toEqual([...expected].sort());
		});

		it('names the integrity material as not exportable and says why', () => {
			expect(
				declarations()
					.filter((entry) => !entry.exportable)
					.map((entry) => [entry.key, (entry.excludedReason ?? '').length > 0]),
			).toEqual([
				['anchors', true],
				['subject-keys', true],
			]);
		});

		it('exports the holds and the erasure history of one workspace alone', async () => {
			await seedHoldAndErasure(ALPHA);
			await seedHoldAndErasure(BETA);
			const byKey = new Map(declarations().map((entry) => [entry.key, entry]));

			const holds = await collect(byKey.get('legal-holds')!, ALPHA);
			const erasures = await collect(byKey.get('erasure-runs')!, ALPHA);

			expect(holds.rows.map((row) => [row.tenantId, row.accountId])).toEqual([
				[ALPHA, 'account-bob'],
			]);
			expect(holds.summary.rows).toBe(1);
			expect(
				erasures.rows.map((row) => [row.tenantId, row.status, row.subject]),
			).toEqual([[ALPHA, 'completed', null]]);
			/* The certificate path and the operator directory are the deployment's
			   filesystem layout, so the archive the workspace receives carries
			   neither. */
			expect(Object.keys(erasures.rows[0]!)).not.toContain('certificatePath');
			expect(Object.keys(erasures.rows[0]!)).not.toContain('outputDirectory');
		});

		/* A hold naming a person is the record of a legal instruction about them,
		   which is what an erasure may not remove. Counting it is what puts it on
		   the certificate instead of leaving the operator to believe the subject is
		   gone from the workspace. */
		it('counts the holds naming a subject and erases none of them', async () => {
			await seedHoldAndErasure(ALPHA);
			const holds = declarations().find(
				(entry) => entry.key === 'legal-holds',
			)!;

			expect(
				await holds.count!({
					tenantId: ALPHA,
					subject: { accountId: 'account-bob' },
				}),
			).toBe(1);
			expect(
				await holds.count!({
					tenantId: ALPHA,
					subject: { accountId: 'account-zoe' },
				}),
			).toBe(0);
			expect(
				await holds.count!({
					tenantId: BETA,
					subject: { accountId: 'account-bob' },
				}),
			).toBe(0);
			expect(holds.erase).toBeUndefined();
		});

		it('declares no erase operation, because audit events are the evidence', () => {
			expect(declarations().every((entry) => entry.erase === undefined)).toBe(
				true,
			);
		});

		it('shows the declared default through the workspace registry', async () => {
			const registry = createDataClassRegistry();
			registry.declare('audit.core', declarations());
			const retention = new AuditRetentionService(
				shared.repository,
				registry,
				() => NOW,
			);

			const classes = await retention.listDataClasses(ALPHA);

			expect(
				classes.map((record) => [
					record.classId,
					record.effectiveRetentionDays,
				]),
			).toEqual([
				['audit.core.events', 400],
				['audit.core.sweep-runs', 400],
				['audit.core.export-runs', 400],
				['audit.core.legal-holds', null],
				['audit.core.erasure-runs', null],
				['audit.core.anchors', null],
				['audit.core.subject-keys', null],
			]);
		});
	});

	it('keeps the chain sweep bounded by the newest anchor', async () => {
		await shared.repository.appendAuditEvent({
			tenantId: ALPHA,
			actorId: 'audit.core',
			action: AUDIT_EVENT_ACTIONS.retentionSweep,
			subjectType: 'data-class',
			subjectId: 'agents.core.runs',
			metadata: {},
			occurredAt: NOW - 500 * DAY,
		});
		const [events] = declarations();

		await expect(
			events!.sweep!({
				tenantId: ALPHA,
				cutoff: new Date(NOW - AUDIT_DEFAULT_RETENTION_DAYS * DAY),
				limit: 100,
			}),
		).rejects.toMatchObject({ code: 'SEGMENT_NOT_SEALED' });
	});
});
