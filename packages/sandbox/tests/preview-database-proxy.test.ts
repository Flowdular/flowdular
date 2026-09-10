import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	DatabaseError,
	runDatabaseMigrations,
	type DatabaseAdapterLease,
	type DatabaseMigration,
	type DatabaseProvider,
	type DatabaseTransaction,
} from '@flowdular/database';
import {
	createPreviewDatabaseHost,
	type PreviewDatabaseHost,
} from '../src/server/preview-database-host.ts';
import { createRemoteDatabaseProvider } from '../src/server/preview-database-proxy.ts';
import { createPreviewDatabaseProvider } from '../src/server/preview-database.ts';

const MIGRATION: DatabaseMigration = {
	id: '0001_draft_records',
	sql: {
		postgresql: `CREATE TABLE draft_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL
);
ALTER TABLE draft_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_records FORCE ROW LEVEL SECURITY;
CREATE POLICY draft_records_tenant_policy ON draft_records
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));`,
	},
};

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

interface Link {
	/** What draft module code sees: an ordinary provider, engine elsewhere. */
	readonly databases: DatabaseProvider;
	readonly host: PreviewDatabaseHost;
	/** Cuts the channel in both directions, the way a killed worker does. */
	stop(): Promise<void>;
}

/* The two sides talk over microtasks instead of a child process, so a test can
   suspend a transaction callback between statements and still be deterministic. */
function link(open: () => Promise<DatabaseProvider>): Link {
	let deliver: ((message: unknown) => void) | undefined;
	let connected = true;
	const host = createPreviewDatabaseHost({
		open,
		send: (reply) => {
			if (connected) queueMicrotask(() => deliver?.(reply));
		},
	});
	const databases = createRemoteDatabaseProvider({
		send: (request) => {
			if (!connected) throw new Error('The preview worker is gone.');
			queueMicrotask(() => host.accept(request));
		},
		subscribe: (listener) => {
			deliver = listener;
		},
	});
	return {
		databases,
		host,
		stop: async () => {
			connected = false;
			await host.close();
		},
	};
}

let dataPath: string;
let engine: DatabaseProvider;

beforeEach(async () => {
	dataPath = await mkdtemp(join(tmpdir(), 'flowdular-preview-proxy-'));
	engine = createPreviewDatabaseProvider(dataPath);
});

afterEach(async () => {
	await engine.dispose();
	await rm(dataPath, { recursive: true, force: true });
});

/* The host owns whatever it opens, so a test that must outlive the host hands
   it a façade over the engine the test itself disposes. */
function borrowed(): Promise<DatabaseProvider> {
	return Promise.resolve({
		acquire: (request) => engine.acquire(request),
		dispose: () => Promise.resolve(),
	});
}

async function migrate(databases: DatabaseProvider): Promise<void> {
	const lease = await databases.acquire({
		namespace: 'draft.core',
		purpose: 'migration',
	});
	try {
		await runDatabaseMigrations(lease.database, 'draft.core', [MIGRATION]);
	} finally {
		await lease.release();
	}
}

function runtimeLease(
	databases: DatabaseProvider,
): Promise<DatabaseAdapterLease> {
	return databases.acquire({ namespace: 'draft.core', purpose: 'preview' });
}

async function records(
	lease: DatabaseAdapterLease,
	tenantId: string,
): Promise<readonly string[]> {
	const result = await lease.database.transaction(
		(transaction) =>
			transaction.query<{ id: string }>({
				text: 'SELECT id FROM draft_records ORDER BY id',
			}),
		{ access: 'read', tenantId },
	);
	return result.rows.map((row) => row.id);
}

describe('preview database proxy', () => {
	/* The migration runner reads capabilities.sql, takes the migration lock,
	   introspects the ledger and writes it, all inside one pinned transaction.
	   Running it end to end proves the whole remote handle, not one statement. */
	it('migrates and commits a transaction across the channel', async () => {
		const channel = link(borrowed);
		await migrate(channel.databases);
		const lease = await runtimeLease(channel.databases);

		await lease.database.transaction(
			(transaction) =>
				transaction.execute({
					text: 'INSERT INTO draft_records (id, tenant_id) VALUES ($1, $2)',
					parameters: ['kept', 'tenant-a'],
				}),
			{ access: 'write', tenantId: 'tenant-a' },
		);

		expect(await records(lease, 'tenant-a')).toEqual(['kept']);
		expect(await records(lease, 'tenant-b')).toEqual([]);
		await lease.release();
		await channel.stop();
	}, 30_000);

	it('rolls back the parent transaction when the callback rejects', async () => {
		const channel = link(borrowed);
		await migrate(channel.databases);
		const lease = await runtimeLease(channel.databases);

		await expect(
			lease.database.transaction(
				async (transaction) => {
					await transaction.execute({
						text: 'INSERT INTO draft_records (id, tenant_id) VALUES ($1, $2)',
						parameters: ['undone', 'tenant-a'],
					});
					throw new Error('the draft changed its mind');
				},
				{ access: 'write', tenantId: 'tenant-a' },
			),
		).rejects.toThrow('the draft changed its mind');

		expect(await records(lease, 'tenant-a')).toEqual([]);
		await channel.stop();
	}, 30_000);

	/* The callback lives in the worker and the connection in the parent, so a
	   worker that dies mid-transaction must not leave either behind. */
	it('rolls back and frees the connection when the worker dies mid transaction', async () => {
		const channel = link(borrowed);
		await migrate(channel.databases);
		const lease = await runtimeLease(channel.databases);
		const inserted = deferred();
		const suspended = deferred();

		const abandoned = lease.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: 'INSERT INTO draft_records (id, tenant_id) VALUES ($1, $2)',
					parameters: ['ghost', 'tenant-a'],
				});
				inserted.resolve();
				await suspended.promise;
			},
			{ access: 'write', tenantId: 'tenant-a' },
		);
		abandoned.catch(() => undefined);
		await inserted.promise;

		await channel.stop();

		const survivor = await runtimeLease(engine);
		expect(await records(survivor, 'tenant-a')).toEqual([]);
		await survivor.release();
	}, 30_000);

	it('closes the engine it opened when the worker is gone', async () => {
		const ownPath = await mkdtemp(join(tmpdir(), 'flowdular-preview-own-'));
		const own = createPreviewDatabaseProvider(ownPath);
		const channel = link(() => Promise.resolve(own));
		const lease = await channel.databases.acquire({
			namespace: 'draft.core',
			purpose: 'migration',
		});
		await lease.database.executeScript('SELECT 1');

		await channel.stop();

		await expect(
			own.acquire({ namespace: 'draft.core', purpose: 'preview' }),
		).rejects.toMatchObject({ code: 'ADAPTER_DISPOSED' });
		await rm(ownPath, { recursive: true, force: true });
	}, 30_000);

	it('keeps TENANT_CONTEXT_REQUIRED observable in the worker', async () => {
		const channel = link(borrowed);
		const lease = await runtimeLease(channel.databases);

		const refused = await lease.database
			.transaction(async () => undefined, { access: 'read' })
			.catch((error: unknown) => error);

		expect(refused).toBeInstanceOf(DatabaseError);
		expect(refused).toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
		await expect(
			lease.database.query({ text: 'SELECT 1' }),
		).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
		await channel.stop();
	}, 30_000);

	it('keeps TRANSACTION_CONTEXT_MISUSE observable in the worker', async () => {
		const channel = link(borrowed);
		const lease = await channel.databases.acquire({
			namespace: 'draft.core',
			purpose: 'migration',
		});

		await expect(
			lease.database.transaction(async () => {
				await lease.database.query({ text: 'SELECT 1' });
			}),
		).rejects.toMatchObject({ code: 'TRANSACTION_CONTEXT_MISUSE' });

		let escaped: DatabaseTransaction | undefined;
		await lease.database.transaction(async (transaction) => {
			escaped = transaction;
		});
		await expect(escaped?.query({ text: 'SELECT 1' })).rejects.toMatchObject({
			code: 'TRANSACTION_CONTEXT_MISUSE',
		});
		await channel.stop();
	}, 30_000);

	/* A statement the worker gave up on must free the worker at once and still
	   leave the parent connection usable once the query it started lands. */
	it('abandons a statement whose deadline fired without deadlocking', async () => {
		const channel = link(borrowed);
		const lease = await channel.databases.acquire({
			namespace: 'draft.core',
			purpose: 'migration',
		});
		const controller = new AbortController();

		const slow = lease.database.query(
			{ text: 'SELECT pg_sleep(0.25)' },
			{ signal: controller.signal },
		);
		controller.abort();

		await expect(slow).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
		const after = await lease.database.query<{ answer: number }>({
			text: 'SELECT 1 AS answer',
		});
		expect(after.rows).toEqual([{ answer: 1 }]);
		await channel.stop();
	}, 30_000);
});
