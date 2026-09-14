import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapterLease,
	type DatabaseHandle,
	type DatabaseOperationOptions,
	type DatabaseRow,
	type DatabaseStatement,
} from '@flowdular/database';
import { createKeyring } from '@flowdular/kernel';
import {
	createStoragePort,
	storageConfigFromEnvironment,
	type ManagedStoragePort,
	type StorageObjectRef,
} from '@flowdular/storage';
import cliExtension from '../src/cli/index.ts';
import {
	DocumentsService,
	DOCUMENTS_STORAGE_MODULE,
} from '../src/services/documents-service.ts';
import { rotateDocumentObjects } from '../src/services/storage-rotation.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import { pdfBytes } from './support/files.ts';

const KEY_A = Buffer.alloc(32, 0xa1);
const KEY_B = Buffer.alloc(32, 0xb2);
const KEY_C = Buffer.alloc(32, 0xc3);
const ACCOUNT = 'account-ada';

let context: DocumentsTestContext;
let background: DatabaseAdapterLease;
let ports: ManagedStoragePort[] = [];

beforeAll(async () => {
	context = await openDocumentsTestContext();
	background = await context.databases.acquire({
		namespace: 'documents.core',
		purpose: 'background',
		requirements: {
			dialectIds: [DATABASE_DIALECT_IDS.postgresql],
			capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
		},
	});
});

afterEach(async () => {
	for (const port of ports) await port.dispose();
	ports = [];
	await context.reset();
});

afterAll(async () => {
	await background?.release();
	await context?.dispose();
});

function keyId(key: Buffer): string {
	return createKeyring({ current: key }).keyId;
}

/* The same directory the context's port writes to, under a ring of the test's
   choosing, so an object can be written under one key and rotated to another. */
function portUnder(
	current: Buffer,
	previous: readonly Buffer[] = [],
): ManagedStoragePort {
	const environment = {
		NODE_ENV: 'test',
		FD_STORAGE_ADAPTER: 'local',
		FD_STORAGE_LOCAL_DIRECTORY: context.storage.directory,
	};
	const port = createStoragePort(
		storageConfigFromEnvironment(environment, context.storage.directory),
		{ keyring: createKeyring({ current, previous }) },
	);
	ports.push(port);
	return port;
}

function serviceUnder(key: Buffer): DocumentsService {
	return new DocumentsService({
		repository: context.repository,
		storage: portUnder(key),
		quotaBytes: () => 10 * 1024 * 1024,
		readUrlSeconds: () => 300,
	});
}

async function upload(tenantId: string, key: Buffer, text: string) {
	const file = await serviceUnder(key).upload(tenantId, ACCOUNT, {
		ownerModule: 'directory.core',
		recordRef: 'party-4711',
		filename: `${text}.pdf`,
		contentType: 'application/pdf',
		body: pdfBytes(text),
	});
	return { file, text };
}

function referenceOf(tenantId: string, id: string): StorageObjectRef {
	return { tenantId, moduleId: DOCUMENTS_STORAGE_MODULE, objectId: id };
}

function rotate(
	current: Buffer,
	previous: readonly Buffer[],
	apply: boolean,
	batchSize?: number,
) {
	return rotateDocumentObjects({
		runtime: context.runtime,
		background: background.database,
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
	return Buffer.concat(chunks).toString('latin1');
}

describe('rotating stored document objects', () => {
	it('counts a mixed inventory per key without writing, then re-seals the stale objects', async () => {
		const first = await upload('tenant-a', KEY_A, 'first');
		const second = await upload('tenant-a', KEY_B, 'second');
		const removed = await upload('tenant-a', KEY_A, 'removed');
		await serviceUnder(KEY_A).remove('tenant-a', removed.file.id);
		const third = await upload('tenant-b', KEY_A, 'third');

		const dry = await rotate(KEY_B, [KEY_A], false);
		expect(dry).toEqual({
			table: 'documents_files',
			currentKeyId: keyId(KEY_B),
			counts: [
				{ keyId: keyId(KEY_A), objects: 2 },
				{ keyId: keyId(KEY_B), objects: 1 },
			].sort((left, right) => left.keyId.localeCompare(right.keyId)),
			tenants: 2,
			objects: 3,
			stale: 2,
			resealed: 0,
			unknown: 0,
			refused: 0,
			missing: 0,
		});
		expect(
			(await portUnder(KEY_A).stat(referenceOf('tenant-a', first.file.id)))
				?.keyId,
		).toBe(keyId(KEY_A));

		const applied = await rotate(KEY_B, [KEY_A], true);
		expect(applied).toMatchObject({ stale: 2, resealed: 2, unknown: 0 });

		const current = portUnder(KEY_B);
		for (const { file, text } of [first, second, third]) {
			const reference = referenceOf(file.tenantId, file.id);
			expect(await current.stat(reference)).toMatchObject({
				keyId: keyId(KEY_B),
				bytes: file.bytes,
				checksum: file.checksum,
			});
			expect(await readText(current, reference)).toContain(text);
		}
		expect(await context.storage.keys()).toHaveLength(3);
	});

	it('is a no-op on the second run', async () => {
		await upload('tenant-a', KEY_A, 'first');
		await rotate(KEY_B, [KEY_A], true);

		expect(await rotate(KEY_B, [KEY_A], true)).toMatchObject({
			counts: [{ keyId: keyId(KEY_B), objects: 1 }],
			stale: 0,
			resealed: 0,
		});
	});

	it('walks every stale object when a batch holds one', async () => {
		for (const text of ['one', 'two', 'three']) {
			await upload('tenant-a', KEY_A, text);
		}

		expect(await rotate(KEY_B, [KEY_A], true, 1)).toMatchObject({
			objects: 3,
			stale: 3,
			resealed: 3,
		});
		expect((await rotate(KEY_B, [KEY_A], false)).stale).toBe(0);
	});

	it('leaves an object under a key the ring does not hold and reports it', async () => {
		const foreign = await upload('tenant-a', KEY_C, 'foreign');

		const applied = await rotate(KEY_B, [KEY_A], true);

		expect(applied).toMatchObject({
			counts: [{ keyId: keyId(KEY_C), objects: 1 }],
			stale: 0,
			resealed: 0,
			unknown: 1,
		});
		expect(
			(await portUnder(KEY_C).stat(referenceOf('tenant-a', foreign.file.id)))
				?.keyId,
		).toBe(keyId(KEY_C));
	});

	it('reads the inventory on a role that cannot see a storage key', async () => {
		await upload('tenant-a', KEY_A, 'first');

		const inventory = await background.database.transaction(
			(transaction) =>
				transaction.query<{ tenant_id: string; status: string }>({
					text: 'SELECT tenant_id, status FROM documents_files',
				}),
			{ access: 'read' },
		);
		expect(inventory.rows).toEqual([
			{ tenant_id: 'tenant-a', status: 'stored' },
		]);

		for (const column of ['storage_key', 'filename', 'record_ref']) {
			await expect(
				background.database.transaction(
					(transaction) =>
						transaction.query({
							text: `SELECT ${column} FROM documents_files`,
						}),
					{ access: 'read' },
				),
			).rejects.toBeDefined();
		}
	});

	/* A delete that lands while the pass holds the row waits on the FOR UPDATE
	   lock and proceeds when the batch commits. The embedded provider refuses a
	   second transaction while one is open on the handle, so the wait is
	   modelled here: the delete is requested under the lock and started the
	   moment the batch that took it commits, which is when a real server hands
	   it the row. It then removes the re-sealed object instead of racing its
	   rewrite. */
	it('never leaves an orphan when a delete lands while the pass holds the row', async () => {
		const first = await upload('tenant-a', KEY_A, 'first');
		const second = await upload('tenant-a', KEY_A, 'second');
		const service = serviceUnder(KEY_B);
		let requested = false;
		let removal: Promise<unknown> | undefined;
		const runtime: DatabaseHandle = {
			...context.runtime,
			transaction: async (operation, options) => {
				const result = await context.runtime.transaction(
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
				if (requested && !removal) {
					removal = service.remove('tenant-a', first.file.id);
				}
				return result;
			},
		};

		const applied = await rotateDocumentObjects({
			runtime,
			background: background.database,
			storage: portUnder(KEY_B, [KEY_A]),
			apply: true,
		});
		await removal;

		expect(applied).toMatchObject({ stale: 2, resealed: 2 });
		expect(await context.storage.keys()).toEqual([
			`tenant-a/${DOCUMENTS_STORAGE_MODULE}/${second.file.id}`,
		]);
		expect(
			(await context.repository.find('tenant-a', first.file.id))?.status,
		).toBe('deleted');
		expect((await rotate(KEY_B, [KEY_A], false)).stale).toBe(0);
	});

	it('refuses a row that names another workspace object instead of rewriting it', async () => {
		const other = await upload('tenant-b', KEY_A, 'other');
		await context.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: `INSERT INTO documents_files (id, tenant_id, owner_module, record_ref,
					         filename, content_type, bytes, checksum, storage_key,
					         uploader_account_id, scan, status, description, created_at)
					       VALUES ('smuggled', 'tenant-a', 'directory.core', 'party-1', 'x.pdf',
					         'application/pdf', 1, NULL, $1, 'account-ada', 'unscanned',
					         'stored', NULL, 1)`,
					parameters: [other.file.storageKey],
				}),
			{ access: 'write', tenantId: 'tenant-a' },
		);

		await expect(rotate(KEY_B, [KEY_A], true)).rejects.toThrow(
			/not one of its objects/,
		);
		expect(
			(await portUnder(KEY_A).stat(referenceOf('tenant-b', other.file.id)))
				?.keyId,
		).toBe(keyId(KEY_A));
	});
});

describe('the documents secrets-rotate command', () => {
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		const values = {
			FD_STORAGE_ADAPTER: 'local',
			FD_STORAGE_LOCAL_DIRECTORY: context.storage.directory,
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
		(entry) => entry.path.join(' ') === 'documents secrets-rotate',
	);

	function run(apply: boolean) {
		if (!command)
			throw new Error('documents secrets-rotate is not registered.');
		return command.execute({
			workspaceRoot: context.storage.directory,
			moduleRoot: process.cwd(),
			apply,
			flags: new Map(),
			arguments: [],
			databases: context.databases,
		});
	}

	it('is declared as a dry-run capable process capability', () => {
		expect(command?.capability).toMatchObject({
			id: 'documents.storage.rotate',
			risk: 'process',
			requiresApprovedSpec: false,
			supportsDryRun: true,
		});
	});

	it('reports the inventory without writing, then re-seals with the environment ring', async () => {
		const created = await upload('tenant-a', KEY_A, 'command');

		const dry = await run(false);
		expect(dry.data).toMatchObject({
			moduleId: 'documents.core',
			table: 'documents_files',
			currentKeyId: keyId(KEY_B),
			counts: [{ keyId: keyId(KEY_A), objects: 1 }],
			stale: 1,
			resealed: 0,
		});
		expect(JSON.stringify(dry.data)).not.toContain('command');
		expect(
			(await portUnder(KEY_A).stat(referenceOf('tenant-a', created.file.id)))
				?.keyId,
		).toBe(keyId(KEY_A));

		const applied = await run(true);
		expect(applied.data).toMatchObject({ stale: 1, resealed: 1 });
		expect(applied.warnings).toEqual([]);
		expect(
			(await portUnder(KEY_B).stat(referenceOf('tenant-a', created.file.id)))
				?.keyId,
		).toBe(keyId(KEY_B));
		expect((await run(true)).data).toMatchObject({ stale: 0, resealed: 0 });
	});

	it('warns about an object no key in the ring opens', async () => {
		await upload('tenant-a', KEY_C, 'foreign');

		const applied = await run(true);

		expect(applied.data).toMatchObject({ unknown: 1, resealed: 0 });
		expect(applied.warnings).toEqual([
			'1 objects are sealed under a key this ring does not hold and were left as they are. Put that key back in FD_STORAGE_ENCRYPTION_KEY_PREVIOUS before retiring it.',
		]);
	});
});
