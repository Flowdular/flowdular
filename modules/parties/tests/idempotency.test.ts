import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentToolContext } from '@coreloom/harness/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { partiesAgentTools } from '../src/agent/tools.ts';
import type { Party } from '../src/domain/types.ts';
import { createPartiesRuntime } from '../src/server/runtime.ts';

let workspace: string | undefined;

afterEach(() => {
	if (workspace) rmSync(workspace, { recursive: true, force: true });
	workspace = undefined;
});

function databasePath(): string {
	workspace = mkdtempSync(join(tmpdir(), 'coreloom-parties-idempotency-'));
	return join(workspace, 'parties.db');
}

function context(key: string, tenantId = 'tenant-a'): AgentToolContext {
	return {
		runId: 'run-1',
		tenantId,
		requestedBy: 'account-1',
		idempotencyKey: key,
		actor: {
			kind: 'agent',
			id: 'customer-agent',
			label: 'Customer agent',
			runId: 'run-1',
		},
		permissions: new Set(['parties.records.manage']),
		signal: new AbortController().signal,
	};
}

const input = {
	name: 'Acme GmbH',
	kind: 'customer' as const,
	email: 'billing@acme.example',
	vatId: 'DE123456789',
};

describe('party target idempotency', () => {
	it('returns the first result after restart and refuses key reuse for another input or operation', async () => {
		const path = databasePath();
		const firstRuntime = createPartiesRuntime({ databasePath: path });
		const create = partiesAgentTools(firstRuntime)[2]!;
		const first = (await create.execute(
			{ ...input, name: '  Acme GmbH  ', email: 'BILLING@ACME.EXAMPLE' },
			context('party-create-key-1'),
		)) as Party;
		firstRuntime.dispose();

		const recoveredRuntime = createPartiesRuntime({ databasePath: path });
		const recoveredCreate = partiesAgentTools(recoveredRuntime)[2]!;
		const replay = (await recoveredCreate.execute(
			input,
			context('party-create-key-1'),
		)) as Party;
		expect(replay).toEqual(first);
		expect(recoveredRuntime.service().list('tenant-a')).toEqual([first]);
		expect(
			recoveredRuntime.service().history('tenant-a', {
				recordId: first.id,
				limit: 10,
				cursor: null,
			}).entries,
		).toHaveLength(1);

		await expect(
			recoveredCreate.execute(
				{ ...input, name: 'Different customer' },
				context('party-create-key-1'),
			),
		).rejects.toMatchObject({ code: 'PARTY_IDEMPOTENCY_CONFLICT' });
		expect(() =>
			recoveredRuntime
				.service()
				.createIdempotent(
					'tenant-a',
					input,
					context('party-create-key-1').actor!,
					{
						key: 'party-create-key-1',
						operationId: 'parties.customer.create@2',
					},
				),
		).toThrowError(
			expect.objectContaining({ code: 'PARTY_IDEMPOTENCY_CONFLICT' }),
		);

		const tenantB = (await recoveredCreate.execute(
			input,
			context('party-create-key-1', 'tenant-b'),
		)) as Party;
		expect(tenantB.tenantId).toBe('tenant-b');
		expect(recoveredRuntime.service().list('tenant-b')).toHaveLength(1);
		recoveredRuntime.dispose();
	});

	it('keeps the ledger after deletion without adding history on replay', async () => {
		const path = databasePath();
		const runtime = createPartiesRuntime({ databasePath: path });
		const create = partiesAgentTools(runtime)[2]!;
		const created = (await create.execute(
			input,
			context('party-delete-key-1'),
		)) as Party;
		const actor = { kind: 'user', id: 'owner-1', label: 'Owner' } as const;
		runtime.service().archive('tenant-a', created.id, actor);
		runtime.service().delete('tenant-a', created.id, actor);
		expect(runtime.service().list('tenant-a')).toEqual([]);

		expect(await create.execute(input, context('party-delete-key-1'))).toEqual(
			created,
		);
		expect(runtime.service().list('tenant-a')).toEqual([]);
		expect(
			runtime
				.service()
				.history('tenant-a', {
					recordId: created.id,
					limit: 10,
					cursor: null,
				})
				.entries.map((entry) => entry.action),
		).toEqual(['deleted', 'archived', 'created']);
		runtime.dispose();

		const database = new DatabaseSync(path);
		const evidence = database
			.prepare(
				`SELECT tenant_id, idempotency_key, operation_id, input_digest,
				 outcome, result_digest
				 FROM parties_idempotency_ledger`,
			)
			.get() as Record<string, unknown>;
		expect(evidence).toMatchObject({
			tenant_id: 'tenant-a',
			idempotency_key: 'party-delete-key-1',
			operation_id: 'parties.customer.create@1',
			outcome: 'succeeded',
		});
		expect(evidence.input_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(evidence.result_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(JSON.stringify(evidence)).not.toContain('Acme GmbH');
		expect(JSON.stringify(evidence)).not.toContain('billing@acme.example');
		database.close();
	});

	it('rolls back the party and history if the ledger cannot commit', async () => {
		const path = databasePath();
		const initialized = createPartiesRuntime({ databasePath: path });
		initialized.service();
		initialized.dispose();
		const database = new DatabaseSync(path);
		database.exec(`CREATE TRIGGER fail_parties_ledger
		BEFORE INSERT ON parties_idempotency_ledger
		BEGIN
		  SELECT RAISE(ABORT, 'forced ledger failure');
		END;`);
		database.close();

		const runtime = createPartiesRuntime({ databasePath: path });
		await expect(
			partiesAgentTools(runtime)[2]!.execute(
				input,
				context('party-rollback-key-1'),
			),
		).rejects.toThrow();
		expect(runtime.service().list('tenant-a')).toEqual([]);
		runtime.dispose();

		const checked = new DatabaseSync(path);
		expect(
			checked.prepare('SELECT count(*) AS count FROM parties').get(),
		).toEqual({ count: 0 });
		expect(
			checked.prepare('SELECT count(*) AS count FROM parties_history_v2').get(),
		).toEqual({ count: 0 });
		expect(
			checked
				.prepare('SELECT count(*) AS count FROM parties_idempotency_ledger')
				.get(),
		).toEqual({ count: 0 });
		checked.close();
	});

	it('fails closed on a corrupted replay result without recreating the party', async () => {
		const path = databasePath();
		const first = createPartiesRuntime({ databasePath: path });
		const create = partiesAgentTools(first)[2]!;
		const created = (await create.execute(
			input,
			context('party-corrupt-key-1'),
		)) as Party;
		const actor = { kind: 'user', id: 'owner-1', label: 'Owner' } as const;
		first.service().archive('tenant-a', created.id, actor);
		first.service().delete('tenant-a', created.id, actor);
		first.dispose();

		const tamper = new DatabaseSync(path);
		tamper
			.prepare(
				`UPDATE parties_idempotency_ledger SET result_json = ?
				 WHERE tenant_id = ? AND idempotency_key = ?`,
			)
			.run(
				JSON.stringify({ ...created, name: 'Tampered' }),
				'tenant-a',
				'party-corrupt-key-1',
			);
		tamper.close();

		const recovered = createPartiesRuntime({ databasePath: path });
		await expect(
			partiesAgentTools(recovered)[2]!.execute(
				input,
				context('party-corrupt-key-1'),
			),
		).rejects.toMatchObject({ code: 'PARTY_IDEMPOTENCY_LEDGER_CORRUPT' });
		expect(recovered.service().list('tenant-a')).toEqual([]);
		expect(
			await partiesAgentTools(recovered)[2]!.execute(
				input,
				context('party-corrupt-key-1', 'tenant-b'),
			),
		).toMatchObject({ tenantId: 'tenant-b' });
		recovered.dispose();
	});
});
