import type { DatabaseAdapterLease } from '@flowdular/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

/* The chain is verified against a real PostgreSQL so the test can tamper a
   stored row through the schema owner, the way an operator with direct
   database access would, and then re-verify through the repository. */
describe('agent audit chain verification', () => {
	let database: AgentsTestDatabase;
	let owner: DatabaseAdapterLease;

	beforeAll(async () => {
		database = await openAgentsTestDatabase();
		owner = await database.databases.acquire({
			namespace: 'agents.core',
			purpose: 'migration',
		});
	});

	beforeEach(async () => {
		await database.truncate();
	});

	afterAll(async () => {
		await owner?.release();
		await database.dispose();
	});

	async function append(subjectId: string, occurredAt: number, key: string) {
		return await database.repository.appendAuditEvent({
			tenantId: 'tenant-a',
			actorId: 'account-a',
			action: 'agent.updated',
			subjectType: 'agent',
			subjectId,
			metadata: { key },
			occurredAt,
		});
	}

	it('verifies an untouched chain and reports the row that was altered', async () => {
		await append('agent-1', 1_000, 'first');
		const second = await append('agent-2', 2_000, 'second');
		await append('agent-3', 3_000, 'third');

		expect(
			await database.repository.verifyAuditChainDetailed('tenant-a'),
		).toEqual({
			verified: true,
			brokenAt: null,
		});

		await owner.database.transaction(
			(transaction) =>
				transaction.execute({
					text: `UPDATE agent_audit_events_v4 SET metadata_json = $1 WHERE id = $2`,
					parameters: ['{"key":"tampered"}', second.id],
				}),
			{ access: 'write', tenantId: 'tenant-a' },
		);

		expect(
			await database.repository.verifyAuditChainDetailed('tenant-a'),
		).toEqual({
			verified: false,
			brokenAt: second.id,
		});
		expect(await database.repository.verifyAuditChain('tenant-a')).toBe(false);
	});
});
