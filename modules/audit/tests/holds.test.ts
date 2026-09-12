import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDataClassRegistry } from '@flowdular/kernel';
import { AUDIT_EVENT_ACTIONS, AUDIT_REASONS } from '../src/domain/types.ts';
import { createAuditSweepRunner } from '../src/services/audit-runners.ts';
import { AuditHoldService } from '../src/services/hold-service.ts';
import { AuditRetentionService } from '../src/services/retention-service.ts';
import { AuditSweepService } from '../src/services/sweep-service.ts';
import {
	openAuditTestDatabase,
	type AuditTestDatabase,
} from './support/database.ts';
import {
	backupPresent,
	FakeOwnerModule,
	type FakeRow,
} from './support/fake-modules.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const ALPHA = 'tenant-alpha';
const BETA = 'tenant-beta';

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

function rows(tenantId: string, ages: readonly number[]): readonly FakeRow[] {
	return ages.map((days, index) => ({
		tenantId,
		id: `${tenantId}-${index}`,
		at: NOW - days * DAY,
		payload: { ageDays: days },
	}));
}

async function fixture() {
	const owner = new FakeOwnerModule('agents.core', 'runs', [
		...rows(ALPHA, [120, 100, 5]),
		...rows(BETA, [120, 100, 5]),
	]);
	const registry = createDataClassRegistry();
	registry.declare(owner.moduleId, [owner.declaration()]);
	const holds = new AuditHoldService(shared.repository, () => NOW);
	const retention = new AuditRetentionService(
		shared.repository,
		registry,
		() => NOW,
	);
	const sweep = new AuditSweepService({
		repository: shared.repository,
		registry,
		backup: backupPresent(),
		batchSize: () => 500,
		intervalMs: () => 60 * 60_000,
		now: () => NOW,
		holds: (input) => holds.forClass(input),
	});
	for (const tenantId of [ALPHA, BETA]) {
		await retention.setRetention(tenantId, `account-${tenantId}`, {
			classId: owner.classId,
			mode: 'days',
			days: 30,
		});
	}
	const runner = createAuditSweepRunner({
		sweeps: async () => sweep,
		intervalMs: 60 * 60_000,
		now: () => NOW,
	});
	return { owner, holds, retention, runner };
}

describe('AUDIT-HOLD-PLACE', () => {
	it('records who placed a hold and why, and audits it', async () => {
		const { holds } = await fixture();

		const hold = await holds.place(ALPHA, 'account-ada', {
			scopeKind: 'account',
			accountId: 'account-bob',
			reason: 'Pending litigation 2026/114.',
		});

		expect({
			scopeKind: hold.scopeKind,
			accountId: hold.accountId,
			status: hold.status,
			placedBy: hold.placedBy,
			reason: hold.reason,
		}).toEqual({
			scopeKind: 'account',
			accountId: 'account-bob',
			status: 'active',
			placedBy: 'account-ada',
			reason: 'Pending litigation 2026/114.',
		});
		const placed = (await shared.repository.listAuditEvents(ALPHA, 10)).filter(
			(event) => event.action === AUDIT_EVENT_ACTIONS.holdPlaced,
		);
		expect(placed).toHaveLength(1);
		expect(placed[0]?.metadata).toMatchObject({
			scopeKind: 'account',
			accountId: 'account-bob',
			reason: 'Pending litigation 2026/114.',
		});
	});

	it('records who lifted a hold and why, and audits it once', async () => {
		const { holds } = await fixture();
		const hold = await holds.place(ALPHA, 'account-ada', {
			scopeKind: 'workspace',
			reason: 'Regulator request.',
		});

		const lifted = await holds.lift(ALPHA, 'account-ada', {
			id: hold.id,
			reason: 'Matter closed.',
		});
		const again = await holds.lift(ALPHA, 'account-ada', {
			id: hold.id,
			reason: 'Matter closed.',
		});

		expect([lifted.status, lifted.liftedBy, lifted.liftReason]).toEqual([
			'lifted',
			'account-ada',
			'Matter closed.',
		]);
		expect(again.id).toBe(lifted.id);
		expect(
			(await shared.repository.listAuditEvents(ALPHA, 20)).filter(
				(event) => event.action === AUDIT_EVENT_ACTIONS.holdLifted,
			),
		).toHaveLength(1);
	});

	it('refuses a scope the kind does not carry', async () => {
		const { holds } = await fixture();

		await expect(
			holds.place(ALPHA, 'account-ada', {
				scopeKind: 'account',
				reason: 'No account named.',
			}),
		).rejects.toMatchObject({ code: 'HOLD_SCOPE_INVALID' });
		await expect(
			holds.place(ALPHA, 'account-ada', {
				scopeKind: 'workspace',
				accountId: 'account-bob',
				reason: 'A workspace hold covers everything.',
			}),
		).rejects.toMatchObject({ code: 'HOLD_SCOPE_INVALID' });
		await expect(
			holds.place(ALPHA, 'account-ada', {
				scopeKind: 'data-class',
				classId: 'agents.core.runs',
				reason: '',
			}),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
	});
});

describe('AUDIT-HOLD-BLOCKS-SWEEP', () => {
	it('never calls the owner and records the refusal with the stable code', async () => {
		const { owner, holds, runner } = await fixture();
		await holds.place(ALPHA, 'account-ada', {
			scopeKind: 'data-class',
			classId: owner.classId,
			reason: 'Pending litigation.',
		});

		expect(await runner.tick()).toEqual({
			claimed: 2,
			performed: 2,
			failed: 0,
			claimLost: 0,
		});
		expect(owner.sweepCalls.map((call) => call.tenantId)).toEqual([BETA]);
		expect(owner.rows(ALPHA)).toHaveLength(3);
		const [run] = await shared.repository.listSweepRuns(ALPHA, undefined, 10);
		expect([run?.status, run?.reason, run?.removed]).toEqual([
			'refused',
			AUDIT_REASONS.holdActive,
			0,
		]);
		/* Only the owning module could count the rows of a foreign class, so the
		   ledger says the count is absent rather than claiming zero. */
		expect(run?.heldBack).toBeNull();
		expect(owner.rows(BETA).map((row) => row.payload.ageDays)).toEqual([5]);
	});

	it('lets the next pass sweep once the hold is lifted', async () => {
		const { owner, holds, runner } = await fixture();
		const hold = await holds.place(ALPHA, 'account-ada', {
			scopeKind: 'workspace',
			reason: 'Pending litigation.',
		});
		await runner.tick();
		expect(owner.rows(ALPHA)).toHaveLength(3);

		await holds.lift(ALPHA, 'account-ada', {
			id: hold.id,
			reason: 'Matter closed.',
		});
		await runner.tick();

		expect(owner.rows(ALPHA).map((row) => row.payload.ageDays)).toEqual([5]);
	});

	/* An account or a date range names rows, and the kernel sweep input carries
	   no row predicate, so such a hold withholds the whole class. */
	it('withholds the whole class for a hold that names rows rather than a class', async () => {
		const { owner, holds, runner } = await fixture();
		await holds.place(ALPHA, 'account-ada', {
			scopeKind: 'date-range',
			fromAt: NOW - 200 * DAY,
			toAt: NOW,
			reason: 'Investigation window.',
		});

		await runner.tick();

		expect(owner.sweepCalls.map((call) => call.tenantId)).toEqual([BETA]);
		expect(owner.rows(ALPHA)).toHaveLength(3);
	});

	it('records a standing hold refusal once however often the sweep runs', async () => {
		const { owner, holds, runner } = await fixture();
		await holds.place(ALPHA, 'account-ada', {
			scopeKind: 'data-class',
			classId: owner.classId,
			reason: 'Pending litigation.',
		});

		await runner.tick();
		await runner.tick();
		await runner.tick();

		expect(
			await shared.repository.listSweepRuns(ALPHA, 'refused', 10),
		).toHaveLength(1);
	});
});

describe('AUDIT-TENANT-BOUNDARY-0-2', () => {
	it('shows one workspace only its own holds', async () => {
		const { holds } = await fixture();
		await holds.place(ALPHA, 'account-ada', {
			scopeKind: 'workspace',
			reason: 'Alpha matter.',
		});
		await holds.place(BETA, 'account-bob', {
			scopeKind: 'workspace',
			reason: 'Beta matter.',
		});

		expect(
			(await holds.list(ALPHA, undefined)).map((hold) => hold.reason),
		).toEqual(['Alpha matter.']);
		expect((await holds.active(BETA)).map((hold) => hold.reason)).toEqual([
			'Beta matter.',
		]);
	});

	it('rejects a hold row carrying another tenant identifier', async () => {
		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO audit_legal_holds
						 (id, tenant_id, scope_kind, account_id, class_id, from_at, to_at,
						  reason, status, placed_by, placed_at, lifted_by, lift_reason,
						  lifted_at)
						 VALUES ($1, $2, 'workspace', NULL, NULL, NULL, NULL, 'forged',
						         'active', 'account-eve', $3, NULL, NULL, NULL)`,
						parameters: ['forged', BETA, NOW],
					}),
				{ access: 'write', tenantId: ALPHA },
			),
		).rejects.toThrow();
	});
});
