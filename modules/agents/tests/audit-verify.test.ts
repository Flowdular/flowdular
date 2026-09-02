import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAgentRepository } from '../src/services/sqlite-repository.ts';

/* The chain is verified against a file-backed database so the test can tamper a
   stored row through a second connection, the way an attacker with disk access
   would, and then re-verify through the repository. */
describe('agent audit chain verification', () => {
	let dir: string;
	let path: string;
	let repository: SqliteAgentRepository;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'agents-audit-'));
		path = join(dir, 'agents.db');
		repository = new SqliteAgentRepository(path);
	});

	afterEach(() => {
		repository.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function append(subjectId: string, occurredAt: number, key: string) {
		return repository.appendAuditEvent({
			tenantId: 'tenant-a',
			actorId: 'account-a',
			action: 'agent.updated',
			subjectType: 'agent',
			subjectId,
			metadata: { key },
			occurredAt,
		});
	}

	it('verifies an untouched chain and reports the row that was altered', () => {
		append('agent-1', 1_000, 'first');
		const second = append('agent-2', 2_000, 'second');
		append('agent-3', 3_000, 'third');

		expect(repository.verifyAuditChainDetailed('tenant-a')).toEqual({
			verified: true,
			brokenAt: null,
		});

		const tamper = new DatabaseSync(path);
		tamper
			.prepare(
				'UPDATE agent_audit_events_v4 SET metadata_json = ? WHERE id = ?',
			)
			.run('{"key":"tampered"}', second.id);
		tamper.close();

		expect(repository.verifyAuditChainDetailed('tenant-a')).toEqual({
			verified: false,
			brokenAt: second.id,
		});
		expect(repository.verifyAuditChain('tenant-a')).toBe(false);
	});
});
