import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_EVENT_ACTIONS } from '../src/domain/types.ts';
import { createDataClassRegistry } from '@flowdular/kernel';
import { AuditRetentionService } from '../src/services/retention-service.ts';
import { AuditServiceError } from '../src/services/service-error.ts';
import {
	openAuditTestDatabase,
	type AuditTestDatabase,
} from './support/database.ts';
import { FakeOwnerModule } from './support/fake-modules.ts';

const TENANT = 'tenant-retention';
const ACTOR = 'account-ada';

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

function service(kept?: FakeOwnerModule) {
	const registry = createDataClassRegistry();
	const sweepable = new FakeOwnerModule('agents.core', 'runs');
	registry.declare('agents.core', [sweepable.declaration()]);
	registry.declare('users.core', [
		(kept ?? new FakeOwnerModule('users.core', 'members')).declaration({
			key: 'members',
			label: 'Members',
			defaultRetentionDays: null,
			sweep: undefined,
		}),
	]);
	return {
		service: new AuditRetentionService(shared.repository, registry),
		sweepable,
	};
}

describe('AUDIT-RETENTION-SET', () => {
	it('persists 30 days, then none, and audits both', async () => {
		const { service: retention, sweepable } = service();

		const days = await retention.setRetention(TENANT, ACTOR, {
			classId: sweepable.classId,
			mode: 'days',
			days: 30,
		});
		expect({
			mode: days.retentionMode,
			days: days.retentionDays,
			effective: days.effectiveRetentionDays,
		}).toEqual({ mode: 'days', days: 30, effective: 30 });

		const none = await retention.setRetention(TENANT, ACTOR, {
			classId: sweepable.classId,
			mode: 'none',
		});
		expect({
			mode: none.retentionMode,
			days: none.retentionDays,
			effective: none.effectiveRetentionDays,
		}).toEqual({ mode: 'none', days: null, effective: null });

		const events = await shared.repository.listAuditEvents(TENANT, 10);
		expect(
			events.map((event) => [event.action, event.subjectId, event.sequence]),
		).toEqual([
			[AUDIT_EVENT_ACTIONS.retentionSet, sweepable.classId, 2],
			[AUDIT_EVENT_ACTIONS.retentionSet, sweepable.classId, 1],
		]);
		expect(events.at(-1)?.previousHash).toBeNull();
		expect(events[0]?.previousHash).toBe(events[1]?.eventHash);
	});

	it('refuses zero days with a stable error and writes nothing', async () => {
		const { service: retention, sweepable } = service();
		await retention.setRetention(TENANT, ACTOR, {
			classId: sweepable.classId,
			mode: 'days',
			days: 30,
		});

		await expect(
			retention.setRetention(TENANT, ACTOR, {
				classId: sweepable.classId,
				mode: 'days',
				days: 0,
			}),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });

		const [record] = await retention.listDataClasses(TENANT);
		expect(record?.retentionDays).toBe(30);
		expect(await shared.repository.listAuditEvents(TENANT, 10)).toHaveLength(1);
	});

	it('refuses a period in days for a class that cannot be swept', async () => {
		const { service: retention } = service();

		await expect(
			retention.setRetention(TENANT, ACTOR, {
				classId: 'users.core.members',
				mode: 'days',
				days: 30,
			}),
		).rejects.toMatchObject({ code: 'DATA_CLASS_NOT_SWEEPABLE' });

		const kept = await retention.setRetention(TENANT, ACTOR, {
			classId: 'users.core.members',
			mode: 'none',
		});
		expect(kept.effectiveRetentionDays).toBeNull();
	});

	it('refuses a class no composed module declares', async () => {
		const { service: retention } = service();

		await expect(
			retention.setRetention(TENANT, ACTOR, {
				classId: 'ghost.core.rows',
				mode: 'none',
			}),
		).rejects.toBeInstanceOf(AuditServiceError);
	});
});
