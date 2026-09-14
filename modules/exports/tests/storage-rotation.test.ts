import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
import type {
	DatabaseHandle,
	DatabaseOperationOptions,
	DatabaseRow,
	DatabaseStatement,
} from '@flowdular/database';
import { createKeyring } from '@flowdular/kernel';
import {
	createStoragePort,
	storageConfigFromEnvironment,
	type ManagedStoragePort,
	type StorageObjectRef,
} from '@flowdular/storage';
import cliExtension from '../src/cli/index.ts';
import { exportsDataClass } from '../src/services/data-classes.ts';
import { EXPORT_OWNER_MODULE } from '../src/services/export-service.ts';
import { rotateExportObjects } from '../src/services/storage-rotation.ts';
import {
	openExportHarness,
	type ExportTestHarness,
} from './support/harness.ts';

const KEY_A = Buffer.alloc(32, 0xa1);
const KEY_B = Buffer.alloc(32, 0xb2);
const KEY_C = Buffer.alloc(32, 0xc3);

let harness: ExportTestHarness;
let ports: ManagedStoragePort[] = [];

beforeAll(async () => {
	harness = await openExportHarness();
});

afterEach(async () => {
	for (const port of ports) await port.dispose();
	ports = [];
	await harness.reset();
});

afterAll(async () => {
	await harness?.dispose();
});

function keyId(key: Buffer): string {
	return createKeyring({ current: key }).keyId;
}

/* The same directory the harness port writes to, under a ring of the test's
   choosing, so a file can be written under one key and rotated to another. */
function portUnder(
	current: Buffer,
	previous: readonly Buffer[] = [],
): ManagedStoragePort {
	const environment = {
		NODE_ENV: 'test',
		FD_STORAGE_ADAPTER: 'local',
		FD_STORAGE_LOCAL_DIRECTORY: harness.storageDirectory,
	};
	const port = createStoragePort(
		storageConfigFromEnvironment(environment, harness.storageDirectory),
		{ keyring: createKeyring({ current, previous }) },
	);
	ports.push(port);
	return port;
}

function referenceOf(tenantId: string, objectId: string): StorageObjectRef {
	return { tenantId, moduleId: EXPORT_OWNER_MODULE, objectId };
}

/* A completed job and its file, the way the runner leaves them. */
async function completedJob(
	tenantId: string,
	id: string,
	key: Buffer,
	options: { readonly object?: boolean } = {},
) {
	const objectId = `object-${id}`;
	const text = `﻿id,name\r\n1,${id}\r\n`;
	if (options.object !== false) {
		await portUnder(key).put({
			...referenceOf(tenantId, objectId),
			contentType: 'text/csv',
			body: Buffer.from(text, 'utf8'),
		});
	}
	await harness.runtime.transaction(
		(transaction) =>
			transaction.execute({
				text: `INSERT INTO exports_jobs (id, tenant_id, list_id, status,
				         row_count, byte_count, object_id, requester_account_id,
				         requester_json, failure_code, claimed_at, started_at, completed_at)
				       VALUES ($1, $2, 'users.core.members', 'completed', 1, 20, $3,
				         'account-ada', '{}', NULL, NULL, 1, 2)`,
				parameters: [id, tenantId, objectId],
			}),
		{ access: 'write', tenantId },
	);
	return { tenantId, objectId, text };
}

async function failedJob(tenantId: string, id: string) {
	await harness.runtime.transaction(
		(transaction) =>
			transaction.execute({
				text: `INSERT INTO exports_jobs (id, tenant_id, list_id, status,
				         row_count, byte_count, object_id, requester_account_id,
				         requester_json, failure_code, claimed_at, started_at, completed_at)
				       VALUES ($1, $2, 'users.core.members', 'failed', 0, 0, NULL,
				         'account-ada', '{}', 'LIST_UNAVAILABLE', NULL, 1, 2)`,
				parameters: [id, tenantId],
			}),
		{ access: 'write', tenantId },
	);
}

function rotate(
	current: Buffer,
	previous: readonly Buffer[],
	apply: boolean,
	batchSize?: number,
) {
	return rotateExportObjects({
		runtime: harness.runtime,
		background: harness.background,
		storage: portUnder(current, previous),
		apply,
		...(batchSize === undefined ? {} : { batchSize }),
	});
}

async function readText(
	port: ManagedStoragePort,
	reference: StorageObjectRef,
): Promise<string> {
	const read = await port.get(reference);
	if (!read) throw new Error(`No object ${reference.objectId}.`);
	const chunks: Uint8Array[] = [];
	const reader = read.body.getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	return Buffer.concat(chunks).toString('utf8');
}

describe('rotating stored export files', () => {
	it('counts a mixed inventory per key without writing, then re-seals the stale files', async () => {
		const first = await completedJob('tenant-a', 'job-1', KEY_A);
		const second = await completedJob('tenant-a', 'job-2', KEY_B);
		await failedJob('tenant-a', 'job-3');
		const swept = await completedJob('tenant-a', 'job-4', KEY_A, {
			object: false,
		});
		const third = await completedJob('tenant-b', 'job-5', KEY_A);

		const dry = await rotate(KEY_B, [KEY_A], false);
		expect(dry).toEqual({
			table: 'exports_jobs',
			currentKeyId: keyId(KEY_B),
			counts: [
				{ keyId: keyId(KEY_A), objects: 2 },
				{ keyId: keyId(KEY_B), objects: 1 },
			].sort((left, right) => left.keyId.localeCompare(right.keyId)),
			tenants: 2,
			objects: 4,
			stale: 2,
			resealed: 0,
			unknown: 0,
			refused: 0,
			missing: 1,
		});
		expect(
			(await portUnder(KEY_A).stat(referenceOf(first.tenantId, first.objectId)))
				?.keyId,
		).toBe(keyId(KEY_A));

		const applied = await rotate(KEY_B, [KEY_A], true);
		expect(applied).toMatchObject({ stale: 2, resealed: 2, missing: 1 });

		const current = portUnder(KEY_B);
		for (const job of [first, second, third]) {
			const reference = referenceOf(job.tenantId, job.objectId);
			expect((await current.stat(reference))?.keyId).toBe(keyId(KEY_B));
			expect(await readText(current, reference)).toBe(job.text);
		}
		expect(
			await current.stat(referenceOf(swept.tenantId, swept.objectId)),
		).toBeNull();
	});

	it('is a no-op on the second run', async () => {
		await completedJob('tenant-a', 'job-1', KEY_A);
		await rotate(KEY_B, [KEY_A], true);

		expect(await rotate(KEY_B, [KEY_A], true)).toMatchObject({
			counts: [{ keyId: keyId(KEY_B), objects: 1 }],
			stale: 0,
			resealed: 0,
		});
	});

	it('walks every stale file when a batch holds one', async () => {
		for (const id of ['job-1', 'job-2', 'job-3']) {
			await completedJob('tenant-a', id, KEY_A);
		}

		expect(await rotate(KEY_B, [KEY_A], true, 1)).toMatchObject({
			objects: 3,
			stale: 3,
			resealed: 3,
		});
		expect((await rotate(KEY_B, [KEY_A], false)).stale).toBe(0);
	});

	it('leaves a file under a key the ring does not hold and reports it', async () => {
		const foreign = await completedJob('tenant-a', 'job-1', KEY_C);

		expect(await rotate(KEY_B, [KEY_A], true)).toMatchObject({
			counts: [{ keyId: keyId(KEY_C), objects: 1 }],
			stale: 0,
			resealed: 0,
			unknown: 1,
		});
		expect(
			(
				await portUnder(KEY_C).stat(
					referenceOf(foreign.tenantId, foreign.objectId),
				)
			)?.keyId,
		).toBe(keyId(KEY_C));
	});

	/* A sweep that lands while the pass holds the row waits on the FOR UPDATE
	   lock and proceeds when the batch commits. The embedded provider refuses a
	   second transaction while one is open on the handle, so the wait is
	   modelled here: the sweep is requested under the lock and started the
	   moment the batch that took it commits, which is when a real server hands
	   it the rows. It then removes the re-sealed file instead of racing its
	   rewrite. */
	it('never leaves an orphan when the retention sweep lands while the pass holds the row', async () => {
		const first = await completedJob('tenant-a', 'job-1', KEY_A);
		await completedJob('tenant-a', 'job-2', KEY_A);
		const declaration = exportsDataClass(
			async () => harness.repository,
			async () => harness.service,
		);
		let requested = false;
		let sweep: Promise<unknown> | undefined;
		const runtime: DatabaseHandle = {
			...harness.runtime,
			transaction: async (operation, options) => {
				const result = await harness.runtime.transaction(
					(transaction) =>
						operation({
							...transaction,
							query: async <Row extends DatabaseRow = DatabaseRow>(
								statement: DatabaseStatement,
								queryOptions?: DatabaseOperationOptions,
							) => {
								const rows = await transaction.query<Row>(
									statement,
									queryOptions,
								);
								if (statement.text.includes('FOR UPDATE')) requested = true;
								return rows;
							},
						}),
					options,
				);
				if (requested && !sweep) {
					sweep = declaration.sweep!({
						tenantId: 'tenant-a',
						cutoff: new Date(2),
						limit: 1,
					});
				}
				return result;
			},
		};

		const applied = await rotateExportObjects({
			runtime,
			background: harness.background,
			storage: portUnder(KEY_B, [KEY_A]),
			apply: true,
		});
		expect(await sweep).toEqual({ removed: 1 });

		expect(applied).toMatchObject({ stale: 2, resealed: 2 });
		expect(await harness.storedKeys()).toEqual([
			`tenant-a/${EXPORT_OWNER_MODULE}/object-job-2`,
		]);
		expect(
			await harness.repository.findJob('tenant-a', first.objectId),
		).toBeNull();
		expect((await rotate(KEY_B, [KEY_A], false)).stale).toBe(0);
	});

	it('reads the inventory on a role that cannot see an object id', async () => {
		await completedJob('tenant-a', 'job-1', KEY_A);
		await completedJob('tenant-b', 'job-2', KEY_A);

		const inventory = await harness.background.transaction(
			(transaction) =>
				transaction.query<{ tenant_id: string }>({
					text: `SELECT tenant_id FROM exports_jobs WHERE status = 'completed' ORDER BY tenant_id`,
				}),
			{ access: 'read' },
		);
		expect(inventory.rows).toEqual([
			{ tenant_id: 'tenant-a' },
			{ tenant_id: 'tenant-b' },
		]);

		for (const column of ['object_id', 'requester_json', 'list_id']) {
			await expect(
				harness.background.transaction(
					(transaction) =>
						transaction.query({ text: `SELECT ${column} FROM exports_jobs` }),
					{ access: 'read' },
				),
			).rejects.toBeDefined();
		}
	});
});

describe('the exports secrets-rotate command', () => {
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		const values = {
			FD_STORAGE_ADAPTER: 'local',
			FD_STORAGE_LOCAL_DIRECTORY: harness.storageDirectory,
			FD_STORAGE_ENCRYPTION_KEY: KEY_B.toString('base64'),
			FD_STORAGE_ENCRYPTION_KEY_PREVIOUS: KEY_A.toString('base64'),
		};
		for (const [name, value] of Object.entries(values)) {
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
		(entry) => entry.path.join(' ') === 'exports secrets-rotate',
	);

	function run(apply: boolean) {
		if (!command) throw new Error('exports secrets-rotate is not registered.');
		return command.execute({
			workspaceRoot: harness.storageDirectory,
			moduleRoot: process.cwd(),
			apply,
			flags: new Map(),
			arguments: [],
			databases: harness.databases,
		});
	}

	it('is declared as a dry-run capable process capability', () => {
		expect(command?.capability).toMatchObject({
			id: 'exports.storage.rotate',
			risk: 'process',
			requiresApprovedSpec: false,
			supportsDryRun: true,
		});
	});

	it('reports the inventory without writing, then re-seals with the environment ring', async () => {
		const created = await completedJob('tenant-a', 'job-1', KEY_A);

		const dry = await run(false);
		expect(dry.data).toMatchObject({
			moduleId: 'exports.core',
			table: 'exports_jobs',
			currentKeyId: keyId(KEY_B),
			counts: [{ keyId: keyId(KEY_A), objects: 1 }],
			stale: 1,
			resealed: 0,
		});
		expect(JSON.stringify(dry.data)).not.toContain('id,name');
		expect(
			(
				await portUnder(KEY_A).stat(
					referenceOf(created.tenantId, created.objectId),
				)
			)?.keyId,
		).toBe(keyId(KEY_A));

		const applied = await run(true);
		expect(applied.data).toMatchObject({ stale: 1, resealed: 1 });
		expect(applied.warnings).toEqual([]);
		expect(
			(
				await portUnder(KEY_B).stat(
					referenceOf(created.tenantId, created.objectId),
				)
			)?.keyId,
		).toBe(keyId(KEY_B));
		expect((await run(true)).data).toMatchObject({ stale: 0, resealed: 0 });
	});

	it('warns about a job whose file is gone', async () => {
		await completedJob('tenant-a', 'job-1', KEY_A, { object: false });

		const applied = await run(true);

		expect(applied.data).toMatchObject({ missing: 1, resealed: 0 });
		expect(applied.warnings).toEqual([
			'1 jobs name a file the store no longer holds.',
		]);
	});
});
