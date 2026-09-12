import { describe, expect, it } from 'vitest';
import { AUDIT_EVENT_ACTIONS } from '../src/domain/types.ts';
import { DatabaseAuditRepository } from '../src/services/database-repository.ts';
import { createInterleavedAuditDatabase } from './support/interleaved-database.ts';

const ALPHA = 'tenant-alpha';
const BETA = 'tenant-beta';
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);

function event(tenantId: string, index: number) {
	return {
		tenantId,
		actorId: 'audit.core',
		action: AUDIT_EVENT_ACTIONS.retentionSweep,
		subjectType: 'data-class' as const,
		subjectId: `agents.core.runs-${index}`,
		metadata: { index },
		occurredAt: NOW + index,
	};
}

describe('appendAuditEvent under contention', () => {
	/* Two writers of one workspace read the newest sequence and write the next
	   one. Without the workspace's own lock both read the same value, the unique
	   constraint refuses the second insert and its event is lost, so the lock is
	   what makes the second writer wait and append after the first. */
	it('gives concurrent appends of one workspace consecutive sequences', async () => {
		const database = createInterleavedAuditDatabase();
		const repository = new DatabaseAuditRepository({
			runtime: database.handle,
			background: database.handle,
		});

		const written = await Promise.all([
			repository.appendAuditEvent(event(ALPHA, 1)),
			repository.appendAuditEvent(event(ALPHA, 2)),
			repository.appendAuditEvent(event(ALPHA, 3)),
		]);

		expect([...written.map((entry) => entry.sequence)].sort()).toEqual([
			1, 2, 3,
		]);
		expect([...database.sequences].sort()).toEqual([1, 2, 3]);
		expect(new Set(written.map((entry) => entry.previousHash)).size).toBe(3);
	});

	/* The lock is per workspace, so one workspace never waits for another. */
	it('lets two workspaces append at the same time', async () => {
		const database = createInterleavedAuditDatabase();
		const repository = new DatabaseAuditRepository({
			runtime: database.handle,
			background: database.handle,
		});

		const written = await Promise.all([
			repository.appendAuditEvent(event(ALPHA, 1)),
			repository.appendAuditEvent(event(BETA, 1)),
		]);

		expect(written.map((entry) => [entry.tenantId, entry.sequence])).toEqual([
			[ALPHA, 1],
			[BETA, 1],
		]);
	});
});
