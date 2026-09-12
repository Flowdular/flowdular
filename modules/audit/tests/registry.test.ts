import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	createDataClassRegistry,
	type MutablePlatformDataClassRegistry,
} from '@flowdular/kernel';
import { AuditRetentionService } from '../src/services/retention-service.ts';
import { FakeOwnerModule } from './support/fake-modules.ts';
import {
	openAuditTestDatabase,
	type AuditTestDatabase,
} from './support/database.ts';

const TENANT = 'tenant-registry';

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

function composed(): {
	registry: MutablePlatformDataClassRegistry;
	owners: readonly FakeOwnerModule[];
} {
	const owners = [
		new FakeOwnerModule('auth.core', 'authentication-events'),
		new FakeOwnerModule('agents.core', 'runs'),
		new FakeOwnerModule('workflows.core', 'run-payloads'),
	];
	const registry = createDataClassRegistry();
	for (const owner of owners) {
		registry.declare(owner.moduleId, [owner.declaration()]);
	}
	/* automations.core and notifications.core own no class of their own in this
	   composition and say so by declaring an empty list. */
	registry.declare('automations.core', []);
	registry.declare('notifications.core', []);
	return { registry, owners };
}

describe('AUDIT-REGISTRY-DECLARE', () => {
	it('lists every declared class with its module, label, default, exportability and workspace period', async () => {
		const { registry, owners } = composed();
		const service = new AuditRetentionService(shared.repository, registry);

		const modules = await service.listRegistry(TENANT);

		expect(modules.map((entry) => entry.moduleId)).toEqual([
			'auth.core',
			'agents.core',
			'workflows.core',
			'automations.core',
			'notifications.core',
		]);
		const declared = modules.flatMap((entry) => entry.classes);
		expect(declared.map((record) => record.classId).sort()).toEqual(
			owners.map((owner) => owner.classId).sort(),
		);
		for (const record of declared) {
			expect({
				label: record.label,
				exportable: record.exportable,
				sweepable: record.sweepable,
				defaultRetentionDays: record.defaultRetentionDays,
				retentionMode: record.retentionMode,
				effectiveRetentionDays: record.effectiveRetentionDays,
			}).toEqual({
				label: `${record.moduleId} ${record.classId.slice(record.moduleId.length + 1)}`,
				exportable: true,
				sweepable: true,
				defaultRetentionDays: 90,
				retentionMode: 'default',
				effectiveRetentionDays: 90,
			});
		}
	});

	it('reads the whole sealed catalogue through the view one module is bound to', async () => {
		const { registry, owners } = composed();
		registry.seal();
		/* The view audit.core receives from the composition may declare only its
		   own classes; what it reads is every module's. */
		const service = new AuditRetentionService(
			shared.repository,
			registry.forModule('audit.core'),
		);

		const modules = await service.listRegistry(TENANT);

		expect(
			modules.flatMap((entry) => entry.classes).map((r) => r.classId),
		).toEqual(owners.map((owner) => owner.classId));
	});

	it('lists a module that declared nothing as holding no class', async () => {
		const { registry } = composed();
		const service = new AuditRetentionService(shared.repository, registry);

		const modules = await service.listRegistry(TENANT);

		expect(
			modules
				.filter((entry) => entry.classes.length === 0)
				.map((entry) => entry.moduleId),
		).toEqual(['automations.core', 'notifications.core']);
	});

	it('refreshes the facts of a class the owner changed without touching the workspace period', async () => {
		const first = createDataClassRegistry();
		const owner = new FakeOwnerModule('agents.core', 'runs');
		first.declare(owner.moduleId, [owner.declaration()]);
		const before = new AuditRetentionService(shared.repository, first);
		await before.setRetention(TENANT, 'account-ada', {
			classId: owner.classId,
			mode: 'days',
			days: 30,
		});

		const second = createDataClassRegistry();
		second.declare(owner.moduleId, [
			owner.declaration({ label: 'Agent runs', defaultRetentionDays: 180 }),
		]);
		const after = new AuditRetentionService(shared.repository, second);
		const [record] = await after.listDataClasses(TENANT);

		expect({
			label: record!.label,
			defaultRetentionDays: record!.defaultRetentionDays,
			retentionMode: record!.retentionMode,
			retentionDays: record!.retentionDays,
			effectiveRetentionDays: record!.effectiveRetentionDays,
		}).toEqual({
			label: 'Agent runs',
			defaultRetentionDays: 180,
			retentionMode: 'days',
			retentionDays: 30,
			effectiveRetentionDays: 30,
		});
	});
});
