import { createDataClassRegistry } from '@flowdular/kernel';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	directoryDataClasses,
	PROVISIONING_EVENT_RETENTION_DAYS,
} from '../src/services/data-classes.ts';
import type { DirectoryAuthPort } from '../src/services/auth-port.ts';
import { DirectoryAdministrationService } from '../src/services/directory-service.ts';
import {
	openDirectoryTestDatabase,
	type DirectoryTestDatabase,
} from './support/database.ts';

const TENANT = 'tenant-retention';
const OTHER = 'tenant-other';
const DAY_MS = 86_400_000;
const SEPTEMBER = Date.UTC(2026, 8, 11, 9, 30, 0);

let shared: DirectoryTestDatabase;

beforeAll(async () => {
	shared = await openDirectoryTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

/* A sweep and an export read the module's own rows and nothing else, so every
   auth.core call is a defect; the stub turns one into a failure. */
function refusingAuth(): DirectoryAuthPort {
	const names = [
		'findTenantId',
		'hasEnabledIdentityProvider',
		'listRoleKeys',
		'listMembers',
		'countAccountMemberships',
		'createMember',
		'setDisplayName',
		'assignRole',
		'setMembershipStatus',
	] as const;
	return Object.fromEntries(
		names.map((name) => [
			name,
			() =>
				Promise.reject(
					new Error(`A data class operation called auth.core ${name}.`),
				),
		]),
	) as unknown as DirectoryAuthPort;
}

function service(): DirectoryAdministrationService {
	return new DirectoryAdministrationService(
		shared.repository,
		refusingAuth(),
		() => SEPTEMBER,
	);
}

function declared(administration: DirectoryAdministrationService) {
	const registry = createDataClassRegistry();
	registry.declare(
		'directory.core',
		directoryDataClasses(async () => administration),
	);
	const events = registry
		.list()
		.find((module) => module.moduleId === 'directory.core')
		?.classes.find((declaration) => declaration.key === 'provisioning-events');
	if (!events) throw new Error('directory.core declared no event class.');
	return events;
}

/** Four events on four consecutive days in one workspace, the oldest first. */
async function seedFourDays(tenantId = TENANT): Promise<void> {
	for (let offset = 0; offset < 4; offset += 1) {
		await shared.repository.appendEvent({
			id: `${tenantId}-event-${offset}`,
			tenantId,
			tokenId: 'token-scim',
			operation: 'user-create',
			subject: `user-${offset}`,
			outcome: 'applied',
			reason: null,
			occurredAt: SEPTEMBER - (3 - offset) * DAY_MS,
		});
	}
}

function remaining(
	administration: DirectoryAdministrationService,
	tenantId = TENANT,
) {
	return administration.listEvents(tenantId, { limit: 200 });
}

describe('directory.core.provisioning-events data class', () => {
	it('declares the provisioning log with its retention, and nothing else', () => {
		const registry = createDataClassRegistry();
		registry.declare(
			'directory.core',
			directoryDataClasses(async () => service()),
		);

		expect(
			registry
				.list()
				.flatMap((module) =>
					module.classes.map((declaration) => [
						`${module.moduleId}.${declaration.key}`,
						declaration.defaultRetentionDays,
						declaration.exportable,
					]),
				),
		).toEqual([
			[
				'directory.core.provisioning-events',
				PROVISIONING_EVENT_RETENTION_DAYS,
				true,
			],
		]);
	});

	it('removes the events that occurred strictly before the cutoff', async () => {
		await seedFourDays();
		const administration = service();

		const removed = await declared(administration).sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER - 1 * DAY_MS),
			limit: 100,
		});

		/* The two oldest go; the event at the cutoff itself stays, which is what
		   "strictly older" means. */
		expect(removed).toEqual({ removed: 2 });
		expect(
			(await remaining(administration)).map((event) => event.subject),
		).toEqual(['user-3', 'user-2']);
	});

	it('removes no more than the limit it was given', async () => {
		await seedFourDays();
		const administration = service();

		const removed = await declared(administration).sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER + DAY_MS),
			limit: 1,
		});

		expect(removed).toEqual({ removed: 1 });
		expect(await remaining(administration)).toHaveLength(3);
	});

	it('sweeps one workspace without touching another', async () => {
		await seedFourDays();
		await seedFourDays(OTHER);
		const administration = service();

		await declared(administration).sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER + DAY_MS),
			limit: 100,
		});

		expect(await remaining(administration)).toHaveLength(0);
		expect(await remaining(administration, OTHER)).toHaveLength(4);
	});

	it('exports every event of one workspace with its oldest and newest time', async () => {
		await seedFourDays();
		await seedFourDays(OTHER);
		const rows: Record<string, unknown>[] = [];

		const summary = await declared(service()).export!({
			tenantId: TENANT,
			sink: {
				write: async (row) => {
					rows.push(row);
				},
			},
		});

		expect(summary.rows).toBe(4);
		expect(summary.from?.toISOString()).toBe(
			new Date(SEPTEMBER - 3 * DAY_MS).toISOString(),
		);
		expect(summary.to?.toISOString()).toBe(new Date(SEPTEMBER).toISOString());
		expect(rows.map((row) => row['id'])).toEqual([
			`${TENANT}-event-0`,
			`${TENANT}-event-1`,
			`${TENANT}-event-2`,
			`${TENANT}-event-3`,
		]);
	});

	it('walks the export in pages rather than one query', async () => {
		await seedFourDays();
		const rows: Record<string, unknown>[] = [];

		const summary = await service().exportEvents(
			TENANT,
			{
				write: async (row) => {
					rows.push(row);
				},
			},
			2,
		);

		expect(summary.rows).toBe(4);
		expect(new Set(rows.map((row) => row['id'])).size).toBe(4);
	});

	it('exports nothing and reports no range for a workspace without events', async () => {
		const summary = await declared(service()).export!({
			tenantId: 'tenant-empty',
			sink: { write: async () => undefined },
		});

		expect(summary).toEqual({ rows: 0, from: null, to: null });
	});
});
