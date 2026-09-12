import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_EVENT_ACTIONS, AUDIT_REASONS } from '../src/domain/types.ts';
import { createDataClassRegistry } from '@flowdular/kernel';
import type { JobRunner } from '@flowdular/server';
import { createAuditSweepRunner } from '../src/services/audit-runners.ts';
import { NOT_HELD, type LegalHoldCheck } from '../src/services/hold-service.ts';
import { AuditRetentionService } from '../src/services/retention-service.ts';
import { AuditSweepService } from '../src/services/sweep-service.ts';
import {
	openAuditTestDatabase,
	type AuditTestDatabase,
} from './support/database.ts';
import {
	backupMissing,
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

interface Fixture {
	readonly owner: FakeOwnerModule;
	readonly retention: AuditRetentionService;
	/** The platform loop, which is what one pass is driven through. */
	readonly runner: JobRunner;
}

function fixture(options: {
	readonly backup?: ReturnType<typeof backupPresent>;
	readonly batchSize?: number;
	readonly owner?: FakeOwnerModule;
	readonly holds?: LegalHoldCheck;
}): Fixture {
	const owner =
		options.owner ??
		new FakeOwnerModule('agents.core', 'runs', [
			...rows(ALPHA, [120, 100, 5]),
			...rows(BETA, [120, 100, 5]),
		]);
	const registry = createDataClassRegistry();
	registry.declare(owner.moduleId, [owner.declaration()]);
	const retention = new AuditRetentionService(
		shared.repository,
		registry,
		() => NOW,
	);
	const sweep = new AuditSweepService({
		repository: shared.repository,
		registry,
		backup: options.backup ?? backupPresent(),
		batchSize: () => options.batchSize ?? 500,
		intervalMs: () => 60 * 60_000,
		now: () => NOW,
		...(options.holds ? { holds: options.holds } : {}),
	});
	const runner = createAuditSweepRunner({
		sweeps: async () => sweep,
		intervalMs: 60 * 60_000,
		now: () => NOW,
	});
	return { owner, retention, runner };
}

const IDLE_PASS = {
	claimed: 0,
	performed: 0,
	failed: 0,
	claimLost: 0,
} as const;

describe('AUDIT-SWEEP', () => {
	it('removes only rows older than each workspace cutoff and leaves the other workspace alone', async () => {
		const { owner, retention, runner } = fixture({});
		await retention.setRetention(ALPHA, 'account-ada', {
			classId: owner.classId,
			mode: 'days',
			days: 30,
		});
		await retention.setRetention(BETA, 'account-bob', {
			classId: owner.classId,
			mode: 'days',
			days: 110,
		});

		const report = await runner.tick();

		expect(report).toEqual({
			claimed: 2,
			performed: 2,
			failed: 0,
			claimLost: 0,
		});
		expect(owner.rows(ALPHA).map((row) => row.payload.ageDays)).toEqual([5]);
		expect(owner.rows(BETA).map((row) => row.payload.ageDays)).toEqual([
			100, 5,
		]);
	});

	it('records the counts per workspace and class and stamps the sweep', async () => {
		const { owner, retention, runner } = fixture({});
		await retention.setRetention(ALPHA, 'account-ada', {
			classId: owner.classId,
			mode: 'days',
			days: 30,
		});

		await runner.tick();

		const [run] = await shared.repository.listSweepRuns(ALPHA, undefined, 10);
		expect({
			classId: run?.classId,
			removed: run?.removed,
			status: run?.status,
			reason: run?.reason,
			cutoff: run?.cutoff,
		}).toEqual({
			classId: owner.classId,
			removed: 2,
			status: 'completed',
			reason: null,
			cutoff: NOW - 30 * DAY,
		});
		const [record] = await retention.listDataClasses(ALPHA);
		expect(record?.lastSweptAt).toBe(NOW);
		expect(await shared.repository.listSweepRuns(BETA, undefined, 10)).toEqual(
			[],
		);
	});

	it('writes the audit event naming the class, the cutoff and the batch before each batch', async () => {
		const owner = new FakeOwnerModule(
			'agents.core',
			'runs',
			rows(ALPHA, [120, 119, 118, 117, 116]),
		);
		const { retention, runner } = fixture({ owner, batchSize: 2 });
		await retention.setRetention(ALPHA, 'account-ada', {
			classId: owner.classId,
			mode: 'days',
			days: 30,
		});

		await runner.tick();

		expect(owner.sweepCalls.map((call) => call.limit)).toEqual([2, 2, 2]);
		expect(owner.rows(ALPHA)).toEqual([]);
		const events = (await shared.repository.listAuditEvents(ALPHA, 20)).filter(
			(event) => event.action === AUDIT_EVENT_ACTIONS.retentionSweep,
		);
		expect(events).toHaveLength(3);
		expect(events.at(-1)?.metadata).toMatchObject({
			classId: owner.classId,
			cutoff: new Date(NOW - 30 * DAY).toISOString(),
			retentionDays: 30,
			batch: 1,
			limit: 2,
		});
	});

	it('never sweeps a class the workspace keeps until a person deletes it', async () => {
		const { owner, retention, runner } = fixture({});
		await retention.setRetention(ALPHA, 'account-ada', {
			classId: owner.classId,
			mode: 'none',
		});

		expect(await runner.tick()).toEqual(IDLE_PASS);
		expect(owner.sweepCalls).toEqual([]);
		expect(owner.rows(ALPHA)).toHaveLength(3);
	});

	it('records a failing owner as refused and leaves the class due', async () => {
		const { owner, retention, runner } = fixture({});
		owner.failSweep = true;
		await retention.setRetention(ALPHA, 'account-ada', {
			classId: owner.classId,
			mode: 'days',
			days: 30,
		});

		const report = await runner.tick();

		/* The owner's failure is the class's recorded outcome, not the pass's:
		   a refusal is work this pass performed. */
		expect(report).toEqual({
			claimed: 1,
			performed: 1,
			failed: 0,
			claimLost: 0,
		});
		const [run] = await shared.repository.listSweepRuns(ALPHA, undefined, 10);
		expect([run?.status, run?.reason]).toEqual([
			'refused',
			AUDIT_REASONS.ownerSweepFailed,
		]);
		const [record] = await retention.listDataClasses(ALPHA);
		expect(record?.lastSweptAt).toBeNull();
	});
});

describe('AUDIT-SWEEP-NO-BACKUP', () => {
	it('refuses the sweep with a stable reason and removes nothing', async () => {
		const { owner, retention, runner } = fixture({ backup: backupMissing() });
		await retention.setRetention(ALPHA, 'account-ada', {
			classId: owner.classId,
			mode: 'days',
			days: 30,
		});

		const report = await runner.tick();

		expect(report).toEqual({
			claimed: 1,
			performed: 1,
			failed: 0,
			claimLost: 0,
		});
		expect(owner.sweepCalls).toEqual([]);
		expect(owner.rows(ALPHA)).toHaveLength(3);
		const [run] = await shared.repository.listSweepRuns(ALPHA, undefined, 10);
		expect([run?.status, run?.reason]).toEqual([
			'refused',
			AUDIT_REASONS.backupManifestMissing,
		]);
	});

	it('records the standing refusal once however often the sweep runs', async () => {
		const { owner, retention, runner } = fixture({ backup: backupMissing() });
		await retention.setRetention(ALPHA, 'account-ada', {
			classId: owner.classId,
			mode: 'days',
			days: 30,
		});

		await runner.tick();
		await runner.tick();
		await runner.tick();

		expect(
			await shared.repository.listSweepRuns(ALPHA, 'refused', 10),
		).toHaveLength(1);
	});
});

describe('the retention pass on the platform runner', () => {
	function bothWorkspaces(): FakeOwnerModule {
		return new FakeOwnerModule('agents.core', 'runs', [
			...rows(ALPHA, [120, 100, 5]),
			...rows(BETA, [120, 100, 5]),
		]);
	}

	async function bothDue(
		retention: AuditRetentionService,
		owner: FakeOwnerModule,
	) {
		for (const tenantId of [ALPHA, BETA]) {
			await retention.setRetention(tenantId, 'account-ada', {
				classId: owner.classId,
				mode: 'days',
				days: 30,
			});
		}
	}

	/* The sweep claims nothing: the stamp the routing row carried is its fence,
	   and a class another process finished in the meantime is left alone. */
	it('leaves a class whose sweep stamp moved after the routing read', async () => {
		const owner = bothWorkspaces();
		let taken = false;
		const { retention, runner } = fixture({
			owner,
			holds: async ({ tenantId }) => {
				/* Another platform process finished this class in the other
				   workspace while this pass was working through its page. */
				if (tenantId === ALPHA && !taken) {
					taken = true;
					await shared.repository.stampSwept(BETA, owner.classId, NOW);
				}
				return NOT_HELD;
			},
		});
		await bothDue(retention, owner);

		expect(await runner.tick()).toEqual({
			claimed: 2,
			performed: 2,
			failed: 0,
			claimLost: 0,
		});
		expect(owner.sweepCalls.map((call) => call.tenantId)).toEqual([ALPHA]);
		expect(owner.rows(BETA)).toHaveLength(3);
		expect(await shared.repository.listSweepRuns(BETA, undefined, 10)).toEqual(
			[],
		);
	});

	it('sweeps the rest of the page when one class raises', async () => {
		const owner = bothWorkspaces();
		const { retention, runner } = fixture({
			owner,
			holds: async ({ tenantId }) => {
				if (tenantId === ALPHA) throw new Error('the hold check is broken');
				return NOT_HELD;
			},
		});
		await bothDue(retention, owner);

		expect(await runner.tick()).toEqual({
			claimed: 2,
			performed: 1,
			failed: 1,
			claimLost: 0,
		});
		expect(owner.sweepCalls.map((call) => call.tenantId)).toEqual([BETA]);
		expect(owner.rows(ALPHA)).toHaveLength(3);
		expect(owner.rows(BETA).map((row) => row.payload.ageDays)).toEqual([5]);
	});
});
