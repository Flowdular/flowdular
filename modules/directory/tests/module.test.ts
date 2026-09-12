import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapterLease,
} from '@flowdular/database';
import { afterEach, describe, expect, it } from 'vitest';
import { moduleDefinition } from '../src/index.ts';
import { DatabaseDirectoryRepository } from '../src/services/database-repository.ts';
import {
	issueToken,
	openHarness,
	type DirectoryHarness,
} from './support/harness.ts';

const open: DirectoryHarness[] = [];
const leases: DatabaseAdapterLease[] = [];

afterEach(async () => {
	for (const lease of leases.splice(0)) await lease.release();
	for (const harness of open.splice(0)) await harness.dispose();
});

async function harness(): Promise<DirectoryHarness> {
	const created = await openHarness();
	open.push(created);
	return created;
}

describe('directory.core', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('directory.core');
		expect(moduleDefinition.permissions).toEqual([
			'directory.tokens.read',
			'directory.tokens.manage',
			'directory.provisioning.read',
		]);
	});

	it('DIRECTORY-TENANT-BOUNDARY: shows one workspace only its own rows', async () => {
		const suite = await harness();
		const first = await suite.signUp('owner-a@example.com', 'workspace-a');
		const second = await suite.signUp('owner-b@example.com', 'workspace-b');
		await issueToken(suite, first, 'Alpha');
		await issueToken(suite, second, 'Beta');

		const firstList = (await (
			await suite.admin('/api/directory/tokens', 'GET', first)
		).json()) as { tokens: { label: string }[] };
		const secondList = (await (
			await suite.admin('/api/directory/tokens', 'GET', second)
		).json()) as { tokens: { label: string }[] };

		expect(firstList.tokens.map((token) => token.label)).toEqual(['Alpha']);
		expect(secondList.tokens.map((token) => token.label)).toEqual(['Beta']);
	});

	/* A group is unbounded in storage, so a listing has to bound what it embeds
	   or one group could fill a whole response with a workspace's membership. */
	it('bounds the members one group contributes to a listing', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		await issueToken(suite, owner, 'Alpha');
		const lease = await suite.databases.acquire({
			namespace: 'directory.core',
			purpose: 'test',
		});
		leases.push(lease);
		const repository = new DatabaseDirectoryRepository(lease.database);
		const now = Date.now();
		await repository.insertGroup({
			id: 'group-a',
			tenantId: owner.tenantId,
			externalId: null,
			displayName: 'Everyone',
			roleKey: null,
			precedence: 100,
			createdAt: now,
			updatedAt: now,
		});
		for (const name of ['carol', 'alice', 'bob']) {
			await repository.insertUser({
				id: 'user-' + name,
				tenantId: owner.tenantId,
				externalId: null,
				userName: name + '@example.com',
				accountId: 'account-' + name,
				active: true,
				createdAt: now,
				lastSyncedAt: now,
			});
		}
		await repository.applyGroupMembers({
			tenantId: owner.tenantId,
			groupId: 'group-a',
			steps: [
				{ kind: 'set', members: ['user-carol', 'user-alice', 'user-bob'] },
			],
			now,
		});

		const bounded = await repository.listMembersOfGroups(
			owner.tenantId,
			['group-a'],
			2,
		);
		expect(bounded.map((member) => member.userName)).toEqual([
			'alice@example.com',
			'bob@example.com',
		]);
		expect(
			(await repository.listMembersOfGroups(owner.tenantId, ['group-a'], 10))
				.length,
		).toBe(3);
	});

	/* The steps of one request decide the final membership between them. */
	it('applies membership steps in order inside one transaction', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		await issueToken(suite, owner, 'Alpha');
		const lease = await suite.databases.acquire({
			namespace: 'directory.core',
			purpose: 'test',
		});
		leases.push(lease);
		const repository = new DatabaseDirectoryRepository(lease.database);
		const now = Date.now();
		await repository.insertGroup({
			id: 'group-a',
			tenantId: owner.tenantId,
			externalId: null,
			displayName: 'Everyone',
			roleKey: null,
			precedence: 100,
			createdAt: now,
			updatedAt: now,
		});
		for (const name of ['alice', 'bob']) {
			await repository.insertUser({
				id: 'user-' + name,
				tenantId: owner.tenantId,
				externalId: null,
				userName: name + '@example.com',
				accountId: 'account-' + name,
				active: true,
				createdAt: now,
				lastSyncedAt: now,
			});
		}

		const applied = await repository.applyGroupMembers({
			tenantId: owner.tenantId,
			groupId: 'group-a',
			steps: [
				{ kind: 'add', members: ['user-alice'] },
				{ kind: 'remove', members: ['user-alice'] },
				{ kind: 'add', members: ['user-bob'] },
			],
			now,
		});
		expect(applied).toEqual({ added: ['user-bob'], removed: [] });
		expect(
			await repository.listGroupMemberIds(owner.tenantId, 'group-a'),
		).toEqual(['user-bob']);

		/* A repeat of the state the group already holds writes nothing. */
		const repeat = await repository.applyGroupMembers({
			tenantId: owner.tenantId,
			groupId: 'group-a',
			steps: [{ kind: 'set', members: ['user-bob'] }],
			now,
		});
		expect(repeat).toEqual({ added: [], removed: [] });
	});

	/* Several operations of one request land in the same millisecond, so the
	   clock alone cannot order the log a reader pages through. */
	it('orders the provisioning log by storage, not by the clock', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		await issueToken(suite, owner, 'Alpha');
		const lease = await suite.databases.acquire({
			namespace: 'directory.core',
			purpose: 'test',
		});
		leases.push(lease);
		const repository = new DatabaseDirectoryRepository(lease.database);
		const occurredAt = 1_700_000_000_000;
		for (const subject of ['first', 'second', 'third']) {
			await repository.appendEvent({
				id: 'event-' + subject,
				tenantId: owner.tenantId,
				tokenId: 'token-a',
				operation: 'user-create',
				subject,
				outcome: 'applied',
				reason: null,
				occurredAt,
			});
		}

		const page = await repository.listEvents(owner.tenantId, { limit: 2 });
		expect(page.map((event) => event.subject)).toEqual(['third', 'second']);
		const next = await repository.listEvents(owner.tenantId, {
			limit: 2,
			cursor: {
				occurredAt: page[1]!.occurredAt,
				sequence: page[1]!.sequence,
			},
		});
		expect(next.map((event) => event.subject)).toEqual(['first']);
	});

	it('DIRECTORY-TENANT-BOUNDARY: refuses a row carrying another tenant id', async () => {
		const suite = await harness();
		const first = await suite.signUp('owner-a@example.com', 'workspace-a');
		const second = await suite.signUp('owner-b@example.com', 'workspace-b');
		await issueToken(suite, second, 'Beta');
		const lease = await suite.databases.acquire({
			namespace: 'directory.core',
			purpose: 'test',
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [
					DATABASE_CAPABILITY_IDS.ROW_LEVEL_SECURITY,
					DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
					DATABASE_CAPABILITY_IDS.TRANSACTIONS,
				],
			},
		});
		leases.push(lease);

		/* The transaction is bound to the first workspace, so the WITH CHECK of
		   the forced policy is what rejects the second workspace's identifier. */
		await expect(
			lease.database.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO directory_scim_tokens
						 (id, tenant_id, label, token_fingerprint, token_hash, status,
						  created_by, created_at, last_used_at, expires_at, revoked_at)
						 VALUES ('smuggled', $1, 'Smuggled', 'fingerprint', 'hash',
						         'active', 'someone', 1, NULL, NULL, NULL)`,
						parameters: [second.tenantId],
					}),
				{ access: 'write', tenantId: first.tenantId },
			),
		).rejects.toThrow();

		const repository = new DatabaseDirectoryRepository(lease.database);
		expect(await repository.listTokens(second.tenantId)).toHaveLength(1);
	});
});
