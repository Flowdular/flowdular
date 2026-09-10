import { describe, expect, it } from 'vitest';
import {
	PostgresDatabaseAdapter,
	type DatabaseTransaction,
	type PostgresDriverClient,
	type PostgresDriverPool,
	type PostgresDriverQuery,
	type PostgresDriverResult,
} from '../src/index.ts';

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

class FakeClient implements PostgresDriverClient {
	readonly queries: PostgresDriverQuery[] = [];
	readonly releases: (Error | undefined)[] = [];
	handler: (query: PostgresDriverQuery) => Promise<PostgresDriverResult> =
		async () => ({ rows: [], rowCount: 0 });

	query(query: PostgresDriverQuery): Promise<PostgresDriverResult> {
		this.queries.push(query);
		return this.handler(query);
	}

	release(error?: Error): void {
		this.releases.push(error);
	}
}

class FakePool implements PostgresDriverPool {
	ended = 0;
	readonly cancellation = 'driver' as const;

	constructor(readonly client: FakeClient) {}

	async connect(): Promise<PostgresDriverClient> {
		return this.client;
	}

	async end(): Promise<void> {
		this.ended += 1;
	}
}

describe('PostgreSQL database adapter contract', () => {
	it('forwards numbered parameters and AbortSignal to the driver', async () => {
		const client = new FakeClient();
		client.handler = async () => ({ rows: [{ id: 'one' }], rowCount: 1 });
		const pool = new FakePool(client);
		const database = new PostgresDatabaseAdapter({ pool });
		const controller = new AbortController();

		await expect(
			database.query<{ id: string }>(
				{ text: 'SELECT id FROM notes WHERE id = $1', parameters: ['one'] },
				{ signal: controller.signal },
			),
		).resolves.toEqual({ rows: [{ id: 'one' }], rowCount: 1 });
		expect(client.queries[0]).toEqual({
			text: 'SELECT id FROM notes WHERE id = $1',
			values: ['one'],
			signal: controller.signal,
		});
		expect(database.capabilities.cancellation).toBe('driver');
		expect(client.releases).toEqual([undefined]);
		await database.dispose();
	});

	it('pins a transaction to one client and acquires an advisory lock', async () => {
		const client = new FakeClient();
		const pool = new FakePool(client);
		const database = new PostgresDatabaseAdapter({ pool });

		await database.transaction(
			async (transaction) => {
				await transaction.acquireMigrationLock('catalog.core');
				await transaction.execute({
					text: 'UPDATE notes SET body = $1',
					parameters: ['body'],
				});
			},
			{ access: 'write', isolation: 'serializable' },
		);

		expect(client.queries.map((query) => query.text)).toEqual([
			'BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE',
			'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
			'UPDATE notes SET body = $1',
			'COMMIT',
		]);
		expect(client.queries[1]?.values).toEqual([
			'coreloom-migration',
			'catalog.core',
		]);
		expect(client.releases).toEqual([undefined]);
		await database.dispose();
	});

	it('sets a fixed transaction-local tenant context before runtime SQL', async () => {
		const client = new FakeClient();
		const database = new PostgresDatabaseAdapter({
			pool: new FakePool(client),
			tenantRequired: true,
		});

		await database.transaction(
			async (transaction) => {
				await transaction.query({
					text: 'SELECT id FROM records WHERE tenant_id = $1',
					parameters: ['tenant-a'],
				});
			},
			{ access: 'read', tenantId: 'tenant-a' },
		);

		expect(client.queries.map((query) => query.text)).toEqual([
			'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
			"SELECT set_config('coreloom.tenant_id', $1, true)",
			'SELECT id FROM records WHERE tenant_id = $1',
			'COMMIT',
		]);
		expect(client.queries[1]?.values).toEqual(['tenant-a']);
		expect(database.capabilities).toMatchObject({
			tenantIsolation: 'transaction-local-rls',
			rootOperations: 'tenant-transaction-only',
		});
		await database.dispose();
	});

	it('refuses PostgreSQL runtime work without tenant context', async () => {
		const client = new FakeClient();
		const database = new PostgresDatabaseAdapter({
			pool: new FakePool(client),
			tenantRequired: true,
		});

		await expect(database.query({ text: 'SELECT 1' })).rejects.toMatchObject({
			code: 'TENANT_CONTEXT_REQUIRED',
		});
		await expect(
			database.transaction(async () => undefined),
		).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
		expect(client.queries).toEqual([]);
		await database.dispose();
	});

	it('rejects an escaped transaction after the callback ends', async () => {
		const client = new FakeClient();
		const database = new PostgresDatabaseAdapter({
			pool: new FakePool(client),
		});
		let escaped: DatabaseTransaction | undefined;
		await database.transaction(async (transaction) => {
			escaped = transaction;
		});

		await expect(escaped!.query({ text: 'SELECT 1' })).rejects.toMatchObject({
			code: 'TRANSACTION_CONTEXT_MISUSE',
		});
		expect(client.queries.map((query) => query.text)).toEqual([
			'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
			'COMMIT',
		]);
		await database.dispose();
	});

	it('keeps the operation failure and evicts the client when rollback fails', async () => {
		const client = new FakeClient();
		const rollback = new Error('connection lost during rollback');
		client.handler = async (query) => {
			if (query.text === 'ROLLBACK') throw rollback;
			return { rows: [], rowCount: 0 };
		};
		const database = new PostgresDatabaseAdapter({
			pool: new FakePool(client),
		});
		const operation = new Error('business write failed');

		await expect(
			database.transaction(async () => {
				throw operation;
			}),
		).rejects.toBe(operation);
		expect(client.releases).toEqual([rollback]);
		await database.dispose();
	});

	it('evicts a client that cannot begin a transaction', async () => {
		const client = new FakeClient();
		const begin = new Error('connection failed during begin');
		client.handler = async (query) => {
			if (query.text.startsWith('BEGIN')) throw begin;
			return {};
		};
		const database = new PostgresDatabaseAdapter({
			pool: new FakePool(client),
		});

		await expect(database.transaction(async () => undefined)).rejects.toBe(
			begin,
		);
		expect(client.releases).toEqual([begin]);
		await database.dispose();
	});

	it('waits for an accepted query before ending the pool', async () => {
		const waiting = deferred<PostgresDriverResult>();
		const client = new FakeClient();
		client.handler = (query) =>
			query.text === 'SELECT wait' ? waiting.promise : Promise.resolve({});
		const pool = new FakePool(client);
		const database = new PostgresDatabaseAdapter({ pool });
		const query = database.query({ text: 'SELECT wait' });
		await Promise.resolve();
		const disposal = database.dispose();

		expect(database.state).toBe('disposing');
		expect(pool.ended).toBe(0);
		await expect(database.query({ text: 'SELECT late' })).rejects.toMatchObject(
			{
				code: 'ADAPTER_DISPOSED',
			},
		);
		waiting.resolve({ rows: [], rowCount: 0 });
		await query;
		await disposal;
		expect(pool.ended).toBe(1);
		expect(database.state).toBe('disposed');
	});

	it('owns PostgreSQL schema introspection', async () => {
		const client = new FakeClient();
		client.handler = async () => ({ rows: [{ present: 1 }], rowCount: 1 });
		const database = new PostgresDatabaseAdapter({
			pool: new FakePool(client),
		});

		await expect(database.schema.hasColumn('notes', 'body')).resolves.toBe(
			true,
		);
		expect(client.queries[0]).toMatchObject({
			values: ['notes', 'body'],
		});
		expect(client.queries[0]?.text).toContain('information_schema.columns');
		await database.dispose();
	});
});
