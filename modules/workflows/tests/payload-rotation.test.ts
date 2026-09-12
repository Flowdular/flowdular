import type {
	DatabaseHandle,
	DatabaseOperationOptions,
	DatabaseProvider,
	DatabaseRow,
	DatabaseSession,
	DatabaseStatement,
	DatabaseTransaction,
} from '@flowdular/database';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
import type { JsonValue } from '../src/domain/types.ts';
import cliExtension from '../src/cli/index.ts';
import {
	createWorkflowPayloadCodec,
	workflowPayloadKeyId,
	type WorkflowPayloadCodec,
} from '../src/services/payload-codec.ts';
import { createWorkflowCursorCodec } from '../src/services/cursor-codec.ts';
import { rotateWorkflowPayloads } from '../src/services/payload-rotation.ts';
import { workflowsRuntimeOptionsFromEnvironment } from '../src/server/runtime.ts';
import {
	openWorkflowsTestRepository,
	withHandle,
	withOwnerHandle,
	type WorkflowsTestRepository,
} from './support/database.ts';

const KEY_A = Buffer.alloc(32, 0xa1);
const KEY_B = Buffer.alloc(32, 0xb2);
const KEY_C = Buffer.alloc(32, 0xc3);

const codecA = createWorkflowPayloadCodec(KEY_A);
const payload: JsonValue = { order: '42', customer: 'ACME' };

let database: WorkflowsTestRepository;

beforeAll(async () => {
	database = await openWorkflowsTestRepository({ payloadCodec: codecA });
});

afterEach(async () => {
	await withOwnerHandle(database.databases, (owner) =>
		owner.transaction(
			(transaction) =>
				transaction.execute({ text: 'TRUNCATE workflow_payloads' }),
			{ access: 'write' },
		),
	);
});

afterAll(async () => {
	await database?.dispose();
});

/* The rotation reads the inventory across tenants and writes under the tenant
   the inventory named, exactly as the command does. */
function withHandles<T>(
	body: (runtime: DatabaseHandle, background: DatabaseHandle) => Promise<T>,
): Promise<T> {
	return withHandle(database.databases, 'runtime', (runtime) =>
		withHandle(database.databases, 'background', (background) =>
			body(runtime, background),
		),
	);
}

function rotate(
	codec: WorkflowPayloadCodec,
	apply: boolean,
	batchSize?: number,
) {
	return withHandles((runtime, background) =>
		rotateWorkflowPayloads({
			runtime,
			background,
			codec,
			apply,
			...(batchSize === undefined ? {} : { batchSize }),
		}),
	);
}

async function storePayload(
	tenantId: string,
	runId: string,
	payloadId: string,
): Promise<void> {
	const ciphertext = codecA.encrypt(payload, { tenantId, runId, payloadId });
	await withHandle(database.databases, 'runtime', (runtime) =>
		runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: `INSERT INTO workflow_payloads
					       (id, tenant_id, run_id, kind, schema_id, payload_hash,
					        original_byte_size, ciphertext, encryption_key_id, created_at)
					       VALUES ($1, $2, $3, 'execution', 'workflow.input', 'sha256:test',
					               $4, $5, $6, 1000)`,
					parameters: [
						payloadId,
						tenantId,
						runId,
						JSON.stringify(payload).length,
						ciphertext,
						codecA.keyId,
					],
				}),
			{ access: 'write', tenantId },
		),
	);
}

async function storedCiphertext(
	tenantId: string,
	payloadId: string,
): Promise<string> {
	const rows = await withHandle(database.databases, 'runtime', (runtime) =>
		runtime.transaction(
			(transaction) =>
				transaction.query<{ ciphertext: string; encryption_key_id: string }>({
					text: 'SELECT ciphertext, encryption_key_id FROM workflow_payloads WHERE tenant_id = $1 AND id = $2',
					parameters: [tenantId, payloadId],
				}),
			{ access: 'read', tenantId },
		),
	);
	const row = rows.rows[0];
	if (!row) throw new Error(`No stored payload ${payloadId}.`);
	expect(row.ciphertext.split('.')[1]).toBe(row.encryption_key_id);
	return row.ciphertext;
}

interface StoredEnvelope extends DatabaseRow {
	id: string;
	run_id: string;
	ciphertext: string;
}

function forwardQuery(session: DatabaseSession) {
	return <Row extends DatabaseRow = DatabaseRow>(
		statement: DatabaseStatement,
		options?: DatabaseOperationOptions,
	) => session.query<Row>(statement, options);
}

/* The optimistic update refuses only a payload whose envelope changed after the
   batch read it. This handle re-seals the first payload of the batch under the
   old key while that transaction is still open, which is what a write landing
   between the read and the update looks like to the rotation. */
function handleRewritingFirstRow(
	handle: DatabaseHandle,
	tenantId: string,
): DatabaseHandle {
	let rewritten = false;
	const session = (transaction: DatabaseTransaction): DatabaseTransaction => ({
		adapterId: transaction.adapterId,
		dialectId: transaction.dialectId,
		capabilities: transaction.capabilities,
		schema: transaction.schema,
		acquireMigrationLock: (namespace) =>
			transaction.acquireMigrationLock(namespace),
		execute: (statement, options) => transaction.execute(statement, options),
		executeScript: (script, options) =>
			transaction.executeScript(script, options),
		query: async <Row extends DatabaseRow = DatabaseRow>(
			statement: DatabaseStatement,
			options?: DatabaseOperationOptions,
		) => {
			const result = await transaction.query<Row>(statement, options);
			const row = result.rows[0] as StoredEnvelope | undefined;
			if (!rewritten && row?.ciphertext) {
				rewritten = true;
				const context = {
					tenantId,
					runId: row.run_id,
					payloadId: row.id,
				};
				await transaction.execute({
					text: `UPDATE workflow_payloads
					       SET ciphertext = $1, encryption_key_id = $2
					       WHERE tenant_id = $3 AND id = $4`,
					parameters: [
						codecA.encrypt(codecA.decrypt(row.ciphertext, context), context),
						codecA.keyId,
						tenantId,
						row.id,
					],
				});
			}
			return result;
		},
	});
	return {
		adapterId: handle.adapterId,
		dialectId: handle.dialectId,
		capabilities: handle.capabilities,
		schema: handle.schema,
		query: forwardQuery(handle),
		execute: (statement, options) => handle.execute(statement, options),
		executeScript: (script, options) => handle.executeScript(script, options),
		transaction: (operation, options) =>
			handle.transaction(
				(transaction) => operation(session(transaction)),
				options,
			),
	};
}

/* Only the runtime lease writes payloads, so the command reaches the seam while
   the inventory it reads stays untouched. */
function databasesRewritingFirstRow(tenantId: string): DatabaseProvider {
	return {
		acquire: async (request) => {
			const lease = await database.databases.acquire(request);
			if (request.purpose !== 'runtime') return lease;
			return {
				database: handleRewritingFirstRow(lease.database, tenantId),
				release: () => lease.release(),
			};
		},
		dispose: () => database.databases.dispose(),
	};
}

describe('the payload codec across a rotation', () => {
	const context = { tenantId: 'tenant-a', runId: 'run-1', payloadId: 'p-1' };

	it('opens a payload written before the rotation and writes the new key', () => {
		const sealed = codecA.encrypt(payload, context);
		const rotated = createWorkflowPayloadCodec(KEY_B, [KEY_A]);

		expect(rotated.decrypt(sealed, context)).toEqual(payload);
		expect(rotated.encrypt(payload, context).split('.')[1]).toBe(
			workflowPayloadKeyId(KEY_B),
		);
	});

	it('keeps the stored key id spelling every existing row carries', () => {
		expect(codecA.keyId).toBe(workflowPayloadKeyId(KEY_A));
		expect(
			codecA.encrypt(payload, context).startsWith(`v1.${codecA.keyId}.`),
		).toBe(true);
	});

	it('refuses a payload whose key is in neither slot, with a stable code', () => {
		const sealed = codecA.encrypt(payload, context);

		try {
			createWorkflowPayloadCodec(KEY_B, [KEY_C]).decrypt(sealed, context);
			expect.unreachable('an unknown key must not decrypt');
		} catch (error) {
			expect((error as Error).message).toBe('WORKFLOW_PAYLOAD_UNREADABLE');
			expect((error as { cause?: { code?: string } }).cause?.code).toBe(
				'KEY_UNKNOWN',
			);
		}
	});
});

describe('rotating stored workflow payloads', () => {
	it('counts rows per key without writing, then re-seals them under the current key', async () => {
		await storePayload('tenant-a', 'run-a', 'payload-a');
		await storePayload('tenant-b', 'run-b', 'payload-b');
		const codec = createWorkflowPayloadCodec(KEY_B, [KEY_A]);

		const dry = await rotate(codec, false);
		expect(dry).toMatchObject({
			table: 'workflow_payloads',
			currentKeyId: workflowPayloadKeyId(KEY_B),
			counts: [{ keyId: workflowPayloadKeyId(KEY_A), rows: 2 }],
			stale: 2,
			tenants: 2,
			rotated: 0,
			skipped: 0,
		});
		expect(await storedCiphertext('tenant-a', 'payload-a')).toContain(
			workflowPayloadKeyId(KEY_A),
		);

		const applied = await rotate(codec, true);
		expect(applied).toMatchObject({ stale: 2, rotated: 2, skipped: 0 });

		for (const [tenantId, runId, payloadId] of [
			['tenant-a', 'run-a', 'payload-a'],
			['tenant-b', 'run-b', 'payload-b'],
		] as const) {
			const stored = await storedCiphertext(tenantId, payloadId);
			expect(
				createWorkflowPayloadCodec(KEY_B).decrypt(stored, {
					tenantId,
					runId,
					payloadId,
				}),
			).toEqual(payload);
		}
	});

	it('is a no-op on the second run', async () => {
		await storePayload('tenant-a', 'run-a', 'payload-a');
		const codec = createWorkflowPayloadCodec(KEY_B, [KEY_A]);
		await rotate(codec, true);

		expect(await rotate(codec, true)).toMatchObject({
			counts: [{ keyId: workflowPayloadKeyId(KEY_B), rows: 1 }],
			stale: 0,
			tenants: 0,
			rotated: 0,
			skipped: 0,
		});
	});

	it('leaves the rotated payloads readable under the new key alone', async () => {
		await storePayload('tenant-a', 'run-a', 'payload-a');
		await rotate(createWorkflowPayloadCodec(KEY_B, [KEY_A]), true);
		const stored = await storedCiphertext('tenant-a', 'payload-a');
		const context = {
			tenantId: 'tenant-a',
			runId: 'run-a',
			payloadId: 'payload-a',
		};

		expect(createWorkflowPayloadCodec(KEY_B).decrypt(stored, context)).toEqual(
			payload,
		);
		expect(() => codecA.decrypt(stored, context)).toThrowError(
			'WORKFLOW_PAYLOAD_UNREADABLE',
		);
	});

	it('walks every stale payload when a batch holds one', async () => {
		for (const id of ['payload-1', 'payload-2', 'payload-3']) {
			await storePayload('tenant-a', 'run-a', id);
		}
		const codec = createWorkflowPayloadCodec(KEY_B, [KEY_A]);

		expect(await rotate(codec, true, 1)).toMatchObject({
			stale: 3,
			rotated: 3,
			skipped: 0,
		});
		expect((await rotate(codec, false)).stale).toBe(0);
	});

	it('reads the inventory on a role that cannot see a payload', async () => {
		await storePayload('tenant-a', 'run-a', 'payload-a');

		const inventory = await withHandle(
			database.databases,
			'background',
			(handle) =>
				handle.transaction(
					(transaction) =>
						transaction.query<{
							tenant_id: string;
							encryption_key_id: string;
						}>({
							text: 'SELECT tenant_id, encryption_key_id FROM workflow_payloads',
						}),
					{ access: 'read' },
				),
		);
		expect(inventory.rows).toEqual([
			{
				tenant_id: 'tenant-a',
				encryption_key_id: workflowPayloadKeyId(KEY_A),
			},
		]);

		await expect(
			withHandle(database.databases, 'background', (handle) =>
				handle.transaction(
					(transaction) =>
						transaction.query({
							text: 'SELECT ciphertext FROM workflow_payloads',
						}),
					{ access: 'read' },
				),
			),
		).rejects.toBeDefined();
	});

	it('refuses to run when the ring cannot open the stored payloads', async () => {
		await storePayload('tenant-a', 'run-a', 'payload-a');

		await expect(
			rotate(createWorkflowPayloadCodec(KEY_B, [KEY_C]), true),
		).rejects.toThrow('WORKFLOW_PAYLOAD_UNREADABLE');
		expect((await rotate(codecA, false)).stale).toBe(0);
	});
});

describe('the workflows secrets-rotate command', () => {
	const keys = {
		FD_WORKFLOWS_PAYLOAD_KEY: KEY_B.toString('base64'),
		FD_WORKFLOWS_PAYLOAD_KEY_PREVIOUS: KEY_A.toString('base64'),
	};
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const [name, value] of Object.entries(keys)) {
			saved.set(name, process.env[name]);
			process.env[name] = value;
		}
	});

	afterEach(() => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		saved.clear();
	});

	const command = cliExtension.commands.find(
		(entry) => entry.path.join(' ') === 'workflows secrets-rotate',
	);

	function run(apply: boolean, databases = database.databases) {
		if (!command) {
			throw new Error('workflows secrets-rotate is not registered.');
		}
		return command.execute({
			workspaceRoot: process.cwd(),
			moduleRoot: process.cwd(),
			apply,
			flags: new Map(),
			arguments: [],
			databases,
		});
	}

	it('is declared as a dry-run capable process capability', () => {
		expect(command?.capability).toMatchObject({
			id: 'workflows.secrets.rotate',
			risk: 'process',
			requiresApprovedSpec: false,
			supportsDryRun: true,
		});
	});

	it('reports the inventory without writing, then re-seals with the environment key', async () => {
		await storePayload('tenant-a', 'run-a', 'payload-a');
		const context = {
			tenantId: 'tenant-a',
			runId: 'run-a',
			payloadId: 'payload-a',
		};

		const dry = await run(false);
		expect(dry.data).toMatchObject({
			moduleId: 'workflows.core',
			table: 'workflow_payloads',
			currentKeyId: workflowPayloadKeyId(KEY_B),
			counts: [{ keyId: workflowPayloadKeyId(KEY_A), rows: 1 }],
			stale: 1,
			rotated: 0,
		});
		const before = await storedCiphertext('tenant-a', 'payload-a');
		expect(JSON.stringify(dry.data)).not.toContain('ACME');
		expect(JSON.stringify(dry.data)).not.toContain(before);
		expect(before).toContain(workflowPayloadKeyId(KEY_A));

		const applied = await run(true);
		expect(applied.data).toMatchObject({ stale: 1, rotated: 1, skipped: 0 });
		expect(applied.warnings ?? []).toEqual([]);

		const stored = await storedCiphertext('tenant-a', 'payload-a');
		expect(stored).toContain(workflowPayloadKeyId(KEY_B));
		expect(createWorkflowPayloadCodec(KEY_B).decrypt(stored, context)).toEqual(
			payload,
		);
		expect((await run(true)).data).toMatchObject({ stale: 0, rotated: 0 });
	});

	it('leaves a payload rewritten in between for the next run', async () => {
		await storePayload('tenant-a', 'run-a', 'payload-a');
		await storePayload('tenant-a', 'run-a', 'payload-b');

		const contended = await run(true, databasesRewritingFirstRow('tenant-a'));

		expect(contended.data).toMatchObject({
			stale: 2,
			rotated: 1,
			skipped: 1,
		});
		expect(contended.warnings).toEqual([
			'1 payloads were rewritten or expired while this ran and keep their own envelope. Run the command again.',
		]);

		const again = await run(true);
		expect(again.data).toMatchObject({ stale: 1, rotated: 1, skipped: 0 });
		expect(again.warnings ?? []).toEqual([]);
		for (const payloadId of ['payload-a', 'payload-b']) {
			const stored = await storedCiphertext('tenant-a', payloadId);
			expect(
				createWorkflowPayloadCodec(KEY_B).decrypt(stored, {
					tenantId: 'tenant-a',
					runId: 'run-a',
					payloadId,
				}),
			).toEqual(payload);
		}
	});
});

describe('the cursor codec across a rotation', () => {
	it('verifies a cursor signed with the previous key and signs with the current', () => {
		const before = createWorkflowCursorCodec(KEY_A);
		const cursor = before.encode('wfrc1', { after: 'run-1' });
		const after = createWorkflowCursorCodec(KEY_B, [KEY_A]);

		expect(after.decode('wfrc1', cursor)).toMatchObject({ after: 'run-1' });
		expect(() =>
			createWorkflowCursorCodec(KEY_B, [KEY_C]).decode('wfrc1', cursor),
		).toThrowError('WORKFLOW_CURSOR_INVALID');
		/* A cursor this codec issues carries the current key, so the retired key
		   can be dropped once the outstanding pages are gone. */
		expect(() =>
			createWorkflowCursorCodec(KEY_A).decode(
				'wfrc1',
				after.encode('wfrc1', { after: 'run-2' }),
			),
		).toThrowError('WORKFLOW_CURSOR_INVALID');
	});
});

describe('the key environment', () => {
	const saved = new Map<string, string | undefined>();

	function environment(values: Record<string, string>) {
		for (const [name, value] of Object.entries(values)) {
			saved.set(name, process.env[name]);
			process.env[name] = value;
		}
	}

	afterEach(() => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		saved.clear();
	});

	it('reads a comma-separated list of previous payload and cursor keys', () => {
		environment({
			FD_WORKFLOWS_PAYLOAD_KEY: KEY_B.toString('base64'),
			FD_WORKFLOWS_PAYLOAD_KEY_PREVIOUS: `${KEY_A.toString('base64')},${KEY_C.toString('hex')}`,
			FD_WORKFLOWS_CURSOR_KEY: KEY_B.toString('base64'),
			FD_WORKFLOWS_CURSOR_KEY_PREVIOUS: KEY_A.toString('base64'),
		});

		const options = workflowsRuntimeOptionsFromEnvironment(process.env, '/tmp');

		expect(options.payloadKey?.equals(KEY_B)).toBe(true);
		expect(
			options.previousPayloadKeys?.map((key) => key.toString('hex')),
		).toEqual([KEY_A.toString('hex'), KEY_C.toString('hex')]);
		expect(
			options.previousCursorKeys?.map((key) => key.toString('hex')),
		).toEqual([KEY_A.toString('hex')]);
		const codec = createWorkflowPayloadCodec(
			options.payloadKey!,
			options.previousPayloadKeys ?? [],
		);
		const context = { tenantId: 't', runId: 'r', payloadId: 'p' };
		expect(codec.decrypt(codecA.encrypt(payload, context), context)).toEqual(
			payload,
		);
	});

	it('names the variable that carries a bad previous key', () => {
		environment({
			FD_WORKFLOWS_PAYLOAD_KEY: KEY_B.toString('base64'),
			FD_WORKFLOWS_PAYLOAD_KEY_PREVIOUS: 'too-short',
		});

		expect(() =>
			workflowsRuntimeOptionsFromEnvironment(process.env, '/tmp'),
		).toThrowError(
			/FD_WORKFLOWS_PAYLOAD_KEY_PREVIOUS must encode exactly 32 bytes/,
		);
	});
});
