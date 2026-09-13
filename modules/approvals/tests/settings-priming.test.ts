import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	createModuleSettingsRuntime,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsStore,
	type ModuleSettingValue,
} from '@flowdular/kernel';
import { createApprovalsRuntime } from '../src/server/runtime.ts';
import {
	APPROVALS_MODULE_ID,
	APPROVALS_MODULE_SETTINGS,
	approvalsDefaultExpiryDays,
	approvalsPrimedDefaultExpiryDays,
	approvalsPrimedExpiryIntervalMs,
} from '../src/settings.ts';
import {
	openApprovalsTestDatabase,
	type ApprovalsTestDatabase,
} from './support/database.ts';
import { DAY_MS, member, OWNER_ROLE } from './support/harness.ts';

const REQUESTER = 'account-requester';
const MEMBERS = [
	member(REQUESTER, OWNER_ROLE),
	member('account-ada', OWNER_ROLE),
];

function memoryStore(): ModuleSettingsStore {
	const values = new Map<string, Record<string, ModuleSettingValue>>();
	const keyOf = (tenantId: string, moduleId: string) =>
		`${tenantId} ${moduleId}`;
	return {
		load: async (tenantId, moduleId) =>
			values.get(keyOf(tenantId, moduleId)) ?? {},
		save: async (record) => {
			const key = keyOf(record.tenantId, record.moduleId);
			values.set(key, { ...values.get(key), [record.key]: record.value });
		},
		clear: async (tenantId, moduleId, key) => {
			const stored = values.get(keyOf(tenantId, moduleId));
			if (stored) delete stored[key];
		},
	};
}

let shared: ApprovalsTestDatabase;

beforeAll(async () => {
	shared = await openApprovalsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

/* The capability wired the way platform.ts wires it: the settings runtime is
   asynchronous, nothing primes a workspace for the background caller, and
   the open path has to do that itself. */
function capabilityOver(store: ModuleSettingsStore, now: number) {
	const settings = createModuleSettingsRuntime(store);
	settings.declare(APPROVALS_MODULE_SETTINGS);
	const runtime = createApprovalsRuntime({
		databases: shared.databases,
		repository: shared.repository,
		members: async () => MEMBERS,
		member: async (_tenantId, accountId) =>
			MEMBERS.find((entry) => entry.accountId === accountId) ?? null,
		defaultExpiryDays: (tenantId) =>
			approvalsPrimedDefaultExpiryDays(settings, tenantId),
		expiryIntervalMs: () => approvalsPrimedExpiryIntervalMs(settings),
		now: () => now,
	});
	const open = async (tenantId: string) =>
		(await runtime.service()).capability().open({
			tenantId,
			subjectModule: 'workflows.core',
			subjectRef: 'run-1/node-approval',
			permission: 'workflows.runs.approve',
			action: 'approve',
			title: 'Approve the run',
			requesterAccountId: REQUESTER,
			requirement: { roleKey: OWNER_ROLE },
		});
	return { settings, runtime, open };
}

describe('approvals settings priming', () => {
	it('opens a request for a workspace nobody primed and applies the declared default expiry', async () => {
		const now = 1_700_000_000_000;
		const { settings, open } = capabilityOver(memoryStore(), now);
		expect(() =>
			approvalsDefaultExpiryDays(settings, 'tenant-unprimed'),
		).toThrow(/prime/);

		const request = await open('tenant-unprimed');
		expect(request.requirement.expiresInDays).toBe(7);
		expect(request.expiresAt).toBe(now + 7 * DAY_MS);
		/* The open primed the workspace, so the synchronous read now answers. */
		expect(approvalsDefaultExpiryDays(settings, 'tenant-unprimed')).toBe(7);
	});

	it('carries the workspace setting into a request opened without a request path', async () => {
		const now = 1_700_000_000_000;
		const store = memoryStore();
		await store.save({
			tenantId: 'tenant-configured',
			moduleId: APPROVALS_MODULE_ID,
			key: 'defaultExpiryDays',
			value: 30,
			updatedBy: 'owner',
			updatedAt: now,
		});
		const { open } = capabilityOver(store, now);

		const request = await open('tenant-configured');
		expect(request.requirement.expiresInDays).toBe(30);
		expect(request.expiresAt).toBe(now + 30 * DAY_MS);
	});

	it('primes the platform tenant before the expiry loop reads its interval', async () => {
		const store = memoryStore();
		await store.save({
			tenantId: PLATFORM_SETTINGS_TENANT,
			moduleId: APPROVALS_MODULE_ID,
			key: 'expiryIntervalMinutes',
			value: 3,
			updatedBy: 'owner',
			updatedAt: 1,
		});
		const settings = createModuleSettingsRuntime(store);
		settings.declare(APPROVALS_MODULE_SETTINGS);
		expect(await approvalsPrimedExpiryIntervalMs(settings)).toBe(3 * 60_000);
	});
});
