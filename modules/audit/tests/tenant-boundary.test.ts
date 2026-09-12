import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDataClassRegistry } from '@flowdular/kernel';
import { AuditRetentionService } from '../src/services/retention-service.ts';
import {
	AUDIT_TENANT_TABLES,
	openAuditTestDatabase,
	type AuditTestDatabase,
} from './support/database.ts';
import { FakeOwnerModule } from './support/fake-modules.ts';

const ALPHA = 'tenant-alpha';
const BETA = 'tenant-beta';
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);

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

function service() {
	const registry = createDataClassRegistry();
	const owner = new FakeOwnerModule('agents.core', 'runs');
	registry.declare(owner.moduleId, [owner.declaration()]);
	return {
		owner,
		retention: new AuditRetentionService(
			shared.repository,
			registry,
			() => NOW,
		),
	};
}

async function seedBothWorkspaces() {
	const { owner, retention } = service();
	for (const [tenantId, days] of [
		[ALPHA, 30],
		[BETA, 60],
	] as const) {
		await retention.setRetention(tenantId, `account-${tenantId}`, {
			classId: owner.classId,
			mode: 'days',
			days,
		});
		await shared.repository.appendSweepRun({
			tenantId,
			classId: owner.classId,
			cutoff: NOW,
			removed: days,
			status: 'completed',
			reason: null,
			heldBack: null,
			occurredAt: NOW,
		});
		await shared.repository.startExportRun({
			tenantId,
			formatVersion: 'audit-export/1',
			requestedBy: `cli:${tenantId}`,
			outputDirectory: `/var/exports/${tenantId}`,
			dryRun: false,
			workspaceSlug: tenantId,
			workspaceName: tenantId,
			startedAt: NOW,
		});
	}
	return { owner, retention };
}

describe('AUDIT-TENANT-BOUNDARY', () => {
	it('shows one workspace only its own periods, sweeps and exports', async () => {
		await seedBothWorkspaces();

		expect(
			(await shared.repository.listDataClasses(ALPHA)).map((record) => [
				record.tenantId,
				record.retentionDays,
			]),
		).toEqual([[ALPHA, 30]]);
		expect(
			(await shared.repository.listSweepRuns(ALPHA, undefined, 10)).map(
				(run) => [run.tenantId, run.removed],
			),
		).toEqual([[ALPHA, 30]]);
		expect(
			(await shared.repository.listExportRuns(ALPHA, undefined, 10)).map(
				(run) => run.requestedBy,
			),
		).toEqual([`cli:${ALPHA}`]);
		expect(
			(await shared.repository.listAuditEvents(BETA, 10)).every(
				(event) => event.tenantId === BETA,
			),
		).toBe(true);
	});

	it('cannot reach a row of another workspace through a bound transaction', async () => {
		await seedBothWorkspaces();

		expect(
			await shared.repository.getDataClass(ALPHA, 'agents.core.runs'),
		).not.toBeNull();
		const stolen = await shared.runtime.transaction(
			(transaction) =>
				transaction.query<{ tenant_id: string }>({
					text: 'SELECT tenant_id FROM audit_data_classes',
				}),
			{ access: 'read', tenantId: ALPHA },
		);
		expect(stolen.rows.map((row) => row.tenant_id)).toEqual([ALPHA]);
	});

	it('rejects a row carrying another tenant identifier', async () => {
		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO audit_sweep_runs
						 (id, tenant_id, class_id, cutoff, removed, status, reason, occurred_at)
						 VALUES ($1, $2, $3, $4, 0, 'completed', NULL, $4)`,
						parameters: ['forged', BETA, 'agents.core.runs', NOW],
					}),
				{ access: 'write', tenantId: ALPHA },
			),
		).rejects.toThrow();
	});

	it('gives the routing read the routing columns alone on the background role', async () => {
		await seedBothWorkspaces();

		const routing = await shared.repository.listDueDataClasses(NOW, 10);
		expect(routing.map((entry) => entry.tenantId).sort()).toEqual([
			ALPHA,
			BETA,
		]);
		expect(Object.keys(routing[0]!).sort()).toEqual([
			'classId',
			'lastSweptAt',
			'tenantId',
		]);

		await expect(
			shared.background.query({
				text: 'SELECT label FROM audit_data_classes',
			}),
		).rejects.toThrow();
		for (const table of AUDIT_TENANT_TABLES) {
			if (table === 'audit_data_classes') continue;
			await expect(
				shared.background.query({ text: `SELECT * FROM ${table}` }),
			).rejects.toThrow();
		}
	});
});

describe('AUDIT-TENANT-BOUNDARY-0-2', () => {
	async function seedScopedRows(tenantId: string): Promise<void> {
		await shared.repository.insertHold({
			tenantId,
			scopeKind: 'account',
			accountId: `account-${tenantId}`,
			classId: null,
			fromAt: null,
			toAt: null,
			reason: 'Pending litigation.',
			placedBy: 'account-ada',
			placedAt: NOW,
		});
		await shared.repository.subjectKey(tenantId, `account-${tenantId}`, NOW);
		await shared.repository.insertAnchor({
			tenantId,
			anchorSequence: 1,
			fromSequence: 1,
			toSequence: 1,
			rowCount: 1,
			firstOccurredAt: NOW,
			lastOccurredAt: NOW,
			segmentHash: `segment-${tenantId}`,
			previousAnchorHash: null,
			anchorHash: `anchor-${tenantId}`,
			signature: 'a'.repeat(64),
			keyId: 'key-1',
			segmentFile: `audit-segment-${tenantId}.jsonl`,
			sealedBy: 'cli:ada',
			sealedAt: NOW,
		});
	}

	it('shows one workspace only its own holds, anchors and subject keys', async () => {
		await seedScopedRows(ALPHA);
		await seedScopedRows(BETA);

		expect(
			(await shared.repository.listHolds(ALPHA, undefined, 10)).map(
				(hold) => hold.accountId,
			),
		).toEqual([`account-${ALPHA}`]);
		expect(
			(await shared.repository.listAnchors(ALPHA, 10)).map(
				(anchor) => anchor.anchorHash,
			),
		).toEqual([`anchor-${ALPHA}`]);
		expect(
			(await shared.repository.listSubjectKeys(ALPHA, 10)).map(
				(key) => key.subject,
			),
		).toEqual([`account-${ALPHA}`]);
		expect(
			await shared.repository.getSubjectKey(ALPHA, `account-${BETA}`),
		).toBeNull();
	});

	/* A transaction without a workspace reaches a tenant table only if the
	   adapter forgot to require one, so the refusal carries a stable code rather
	   than a driver message. */
	it('refuses a tenant table read with no workspace bound', async () => {
		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.query({ text: 'SELECT id FROM audit_legal_holds' }),
				{ access: 'read' },
			),
		).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
	});

	it('rejects a hold carrying another tenant identifier with a stable code', async () => {
		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO audit_legal_holds
						 (id, tenant_id, scope_kind, account_id, class_id, from_at, to_at,
						  reason, status, placed_by, placed_at, lifted_by, lift_reason,
						  lifted_at)
						 VALUES ('forged', $1, 'workspace', NULL, NULL, NULL, NULL,
						  'Forged.', 'active', 'account-ada', $2, NULL, NULL, NULL)`,
						parameters: [BETA, NOW],
					}),
				{ access: 'write', tenantId: ALPHA },
			),
			/* 42501 is insufficient_privilege: the forced WITH CHECK policy refused
		   the row, rather than the statement failing for some other reason. */
		).rejects.toMatchObject({ code: '42501' });
	});

	/* The background lease exists to find work across workspaces. It reads the
	   routing columns and writes nothing, so a write on it is refused whatever
	   the policy says about the rows. */
	it('refuses a write on the cross-tenant background lease', async () => {
		await expect(
			shared.background.query({
				text: `UPDATE audit_data_classes SET last_swept_at = 1`,
			}),
		).rejects.toThrow();
		await expect(
			shared.background.query({
				text: `DELETE FROM audit_export_runs WHERE id = 'any'`,
			}),
		).rejects.toThrow();
	});
});
