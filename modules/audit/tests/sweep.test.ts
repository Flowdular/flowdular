import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_EVENT_ACTIONS, AUDIT_REASONS } from '../src/domain/types.ts';
import { createDataClassRegistry } from '@flowdular/kernel';
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
	readonly sweep: AuditSweepService;
}

function fixture(options: {
	readonly backup?: ReturnType<typeof backupPresent>;
	readonly batchSize?: number;
	readonly owner?: FakeOwnerModule;
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
	});
	return { owner, retention, sweep };
}

describe('AUDIT-SWEEP', () => {
	it('removes only rows older than each workspace cutoff and leaves the other workspace alone', async () => {
		const { owner, retention, sweep } = fixture({});
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

		const report = await sweep.tick();

		expect(report).toMatchObject({ examined: 2, swept: 2, refused: 0 });
		expect(owner.rows(ALPHA).map((row) => row.payload.ageDays)).toEqual([5]);
		expect(owner.rows(BETA).map((row) => row.payload.ageDays)).toEqual([
			100, 5,
		]);
	});

	it('records the counts per workspace and class and stamps the sweep', async () => {
		const { owner, retention, sweep } = fixture({});
		await retention.setRetention(ALPHA, 'account-ada', {
			classId: owner.classId,
			mode: 'days',
			days: 30,
		});

		await sweep.tick();

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
		const { retention, sweep } = fixture({ owner, batchSize: 2 });
		await retention.setRetention(ALPHA, 'account-ada', {
			classId: owner.classId,
			mode: 'days',
			days: 30,
		});

		await sweep.tick();

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
		const { owner, retention, sweep } = fixture({});
		await retention.setRetention(ALPHA, 'account-ada', {
			classId: owner.classId,
			mode: 'none',
		});

		expect(await sweep.tick()).toMatchObject({ examined: 0, removed: 0 });
		expect(owner.sweepCalls).toEqual([]);
		expect(owner.rows(ALPHA)).toHaveLength(3);
	});

	it('records a failing owner as refused and leaves the class due', async () => {
		const { owner, retention, sweep } = fixture({});
		owner.failSweep = true;
		await retention.setRetention(ALPHA, 'account-ada', {
			classId: owner.classId,
			mode: 'days',
			days: 30,
		});

		const report = await sweep.tick();

		expect(report).toMatchObject({ refused: 1, removed: 0 });
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
		const { owner, retention, sweep } = fixture({ backup: backupMissing() });
		await retention.setRetention(ALPHA, 'account-ada', {
			classId: owner.classId,
			mode: 'days',
			days: 30,
		});

		const report = await sweep.tick();

		expect(report).toMatchObject({ refused: 1, swept: 0, removed: 0 });
		expect(owner.sweepCalls).toEqual([]);
		expect(owner.rows(ALPHA)).toHaveLength(3);
		const [run] = await shared.repository.listSweepRuns(ALPHA, undefined, 10);
		expect([run?.status, run?.reason]).toEqual([
			'refused',
			AUDIT_REASONS.backupManifestMissing,
		]);
	});

	it('records the standing refusal once however often the sweep runs', async () => {
		const { owner, retention, sweep } = fixture({ backup: backupMissing() });
		await retention.setRetention(ALPHA, 'account-ada', {
			classId: owner.classId,
			mode: 'days',
			days: 30,
		});

		await sweep.tick();
		await sweep.tick();
		await sweep.tick();

		expect(
			await shared.repository.listSweepRuns(ALPHA, 'refused', 10),
		).toHaveLength(1);
	});
});
