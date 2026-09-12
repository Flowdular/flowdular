import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TenantMember } from '@flowdular/module-auth';
import type { DirectoryAuthPort } from '../src/services/auth-port.ts';
import { ScimProvisioningService } from '../src/services/provisioning-service.ts';
import type { DirectoryRepository } from '../src/services/repository.ts';
import type { ScimRequestContext } from '../src/services/provisioning-service.ts';
import {
	openDirectoryTestDatabase,
	type DirectoryTestDatabase,
} from './support/database.ts';

const TENANT = 'tenant-recalculation';
const GROUP_SIZE = 50;
const NOW = Date.UTC(2026, 2, 1, 12, 0, 0);

let database: DirectoryTestDatabase;

beforeAll(async () => {
	database = await openDirectoryTestDatabase();
});

afterAll(async () => {
	await database?.dispose();
});

afterEach(async () => {
	await database.reset();
});

/** Every repository call this pass made, by the port method it came through. */
function counting(repository: DirectoryRepository): {
	readonly port: DirectoryRepository;
	readonly calls: Map<string, number>;
} {
	const calls = new Map<string, number>();
	const port = new Proxy(repository, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (typeof value !== 'function' || typeof property !== 'string') {
				return value;
			}
			return (...parameters: unknown[]) => {
				calls.set(property, (calls.get(property) ?? 0) + 1);
				return (value as (...args: unknown[]) => unknown).apply(
					target,
					parameters,
				);
			};
		},
	});
	return { port, calls };
}

function member(accountId: string, role: string): TenantMember {
	return {
		accountId,
		email: accountId + '@example.com',
		displayName: accountId,
		role,
		roleId: null,
		status: 'active',
		membershipStatus: 'active',
		scopes: [],
		passwordChangeRequired: false,
		createdAt: NOW,
	};
}

/** Roles the workspace holds, and the assignments this pass performed. */
function authPort(members: Map<string, TenantMember>): {
	readonly port: DirectoryAuthPort;
	readonly assigned: { accountId: string; roleKey: string }[];
} {
	const assigned: { accountId: string; roleKey: string }[] = [];
	const port = {
		findTenantId: async () => TENANT,
		hasEnabledIdentityProvider: async () => true,
		listRoleKeys: async () => ['owner', 'member', 'lead'],
		listMembers: async () => [...members.values()],
		countAccountMemberships: async () => 0,
		createMember: async () => {
			throw new Error('The recalculation pass created a member.');
		},
		setDisplayName: async () => undefined,
		assignRole: async (_actor: unknown, accountId: string, roleKey: string) => {
			assigned.push({ accountId, roleKey });
			const held = members.get(accountId);
			if (held) members.set(accountId, { ...held, role: roleKey });
		},
		setMembershipStatus: async () => undefined,
	} as unknown as DirectoryAuthPort;
	return { port, assigned };
}

async function seedGroup(
	repository: DirectoryRepository,
	roleKey: string | null,
): Promise<{
	readonly groupId: string;
	readonly userIds: readonly string[];
	readonly members: Map<string, TenantMember>;
}> {
	const groupId = randomUUID();
	await repository.insertGroup({
		id: groupId,
		tenantId: TENANT,
		externalId: null,
		displayName: 'Leads',
		roleKey,
		precedence: 10,
		createdAt: NOW,
		updatedAt: NOW,
	});
	const userIds: string[] = [];
	const members = new Map<string, TenantMember>();
	for (let index = 0; index < GROUP_SIZE; index += 1) {
		const id = randomUUID();
		const accountId = 'account-' + index;
		await repository.insertUser({
			id,
			tenantId: TENANT,
			externalId: null,
			userName: `member-${index}@example.com`,
			accountId,
			active: true,
			createdAt: NOW,
			lastSyncedAt: NOW,
		});
		userIds.push(id);
		members.set(accountId, member(accountId, 'member'));
	}
	return { groupId, userIds, members };
}

function context(): ScimRequestContext {
	return {
		tenantId: TENANT,
		token: {
			id: 'token-1',
			tenantId: TENANT,
			label: 'Okta production',
			tokenFingerprint: 'f'.repeat(32),
			status: 'active',
			createdBy: 'account-owner',
			createdAt: NOW,
			lastUsedAt: null,
			expiresAt: null,
			revokedAt: null,
		},
		baseUrl: 'https://erp.example/api/scim/v2/workspace-a',
		pageSizeMax: 200,
		defaultRole: 'member',
	};
}

function patch(members: readonly string[]) {
	return {
		schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
		Operations: [
			{
				op: 'add',
				path: 'members',
				value: members.map((value) => ({ value })),
			},
		],
	};
}

describe('membership recalculation', () => {
	/* A membership change over a whole group has to cost one read of the
	   precedence rule and one write of the log, not one of each per member. */
	it('resolves a 50-member group in one read and records it in one write', async () => {
		const { port, calls } = counting(database.repository);
		const seed = await seedGroup(port, 'lead');
		const auth = authPort(seed.members);
		const service = new ScimProvisioningService(port, auth.port, () => NOW);
		calls.clear();

		await service.patchGroup(context(), seed.groupId, patch(seed.userIds));

		/* Counted across both spellings of each port method, so the assertion
		   measures the round trips rather than the name they go through. */
		const resolves =
			(calls.get('resolvedRolesForUsers') ?? 0) +
			(calls.get('resolvedRoleFor') ?? 0);
		const eventWrites =
			(calls.get('appendEvents') ?? 0) + (calls.get('appendEvent') ?? 0);
		expect(resolves).toBe(1);
		/* One write for the operation itself and one for the whole pass: neither
		   grows with the size of the group. */
		expect(eventWrites).toBe(2);
		expect(auth.assigned).toHaveLength(GROUP_SIZE);
		expect(new Set(auth.assigned.map((entry) => entry.roleKey))).toEqual(
			new Set(['lead']),
		);
	});

	/* The same rule from both directions: a member who leaves the last mapped
	   group falls back to the workspace default rather than keeping the role. */
	it('returns every member of an emptied group to the default role', async () => {
		const { port } = counting(database.repository);
		const seed = await seedGroup(port, 'lead');
		const auth = authPort(seed.members);
		const service = new ScimProvisioningService(port, auth.port, () => NOW);
		await service.patchGroup(context(), seed.groupId, patch(seed.userIds));

		await service.patchGroup(context(), seed.groupId, {
			schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
			Operations: [{ op: 'remove', path: 'members' }],
		});

		expect(
			[...seed.members.values()].every((entry) => entry.role === 'member'),
		).toBe(true);
		const events = await database.repository.listEvents(TENANT, { limit: 200 });
		const subjects = new Set<string>(seed.userIds);
		expect(
			events.filter(
				(event) => subjects.has(event.subject) && event.outcome === 'applied',
			),
		).toHaveLength(GROUP_SIZE * 2);
	});
});
