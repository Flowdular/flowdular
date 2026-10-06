import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';
import {
	createDatabaseProvider,
	databaseProviderConfigFromEnvironment,
	type ConfiguredDatabaseProvider,
	type DatabaseProviderFactories,
	type DatabaseSession,
} from '@flowdular/database';
import { Client, Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

const migratorUrl = process.env.FD_TEST_POSTGRES_URL?.trim();

/* Built the way the platform, the operator CLI and generated projects build it:
   a plain node-postgres pool handed to the provider. */
function postgresProvider(
	postgresPool: NonNullable<DatabaseProviderFactories['postgresPool']> = (
		options,
	) => new Pool(options),
	url = migratorUrl,
): ConfiguredDatabaseProvider {
	return createDatabaseProvider(
		databaseProviderConfigFromEnvironment(
			{
				FD_DATABASE_ADAPTER: 'postgresql',
				FD_DATABASE_URL: url,
				FD_DATABASE_TLS: 'disable',
			},
			process.cwd(),
		),
		{ postgresPool },
	);
}

async function backendPid(
	session: Pick<DatabaseSession, 'query'>,
): Promise<number> {
	const { rows } = await session.query<{ pid: number }>({
		text: 'SELECT pg_backend_pid() AS pid',
	});
	return rows[0]!.pid;
}

async function waitForBackend(
	admin: Client,
	pid: number,
	until: 'running' | 'gone',
): Promise<void> {
	for (;;) {
		const { rowCount } = await admin.query(
			until === 'running'
				? "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND state = 'active'"
				: 'SELECT 1 FROM pg_stat_activity WHERE pid = $1',
			[pid],
		);
		if (until === 'running' ? rowCount : !rowCount) return;
	}
}

/* What a suspended compute, a failover or a restart does to a connection. A
   role may terminate its own backends, so the test needs no superuser. Resolves
   once the backend has exited, so its FATAL is on the way to the client. */
async function terminateBackend(
	pid: number,
	{ whileRunning = false } = {},
): Promise<void> {
	const admin = new Client({ connectionString: migratorUrl });
	await admin.connect();
	try {
		if (whileRunning) await waitForBackend(admin, pid, 'running');
		await admin.query('SELECT pg_terminate_backend($1)', [pid]);
		await waitForBackend(admin, pid, 'gone');
	} finally {
		await admin.end();
	}
}

/* Vitest survives an uncaught exception that would end a real process, so the
   test records them itself. Messages only: the error carries the client. */
function recordUncaughtExceptions(): {
	readonly messages: string[];
	readonly first: Promise<void>;
	stop(): void;
} {
	const messages: string[] = [];
	let recorded!: () => void;
	const first = new Promise<void>((resolve) => {
		recorded = resolve;
	});
	const record = (error: unknown) => {
		messages.push(String(error));
		recorded();
	};
	process.on('uncaughtException', record);
	return {
		messages,
		first,
		stop: () => process.off('uncaughtException', record),
	};
}

describe('node-postgres pool handed to the provider', () => {
	/* pg runs the connect callback inside the socket read that carried
	   ReadyForQuery and parses a FATAL from the same read right after it, before
	   the pool's connect() promise settles. */
	it('guards a new client against a FATAL read with its ReadyForQuery', async () => {
		const escaped: string[] = [];
		class SameReadFatalClient extends EventEmitter {
			_queryable = true;
			_ending = false;
			connect(callback: (error?: Error) => void): void {
				setImmediate(() => {
					callback();
					this._queryable = false;
					try {
						this.emit(
							'error',
							Object.assign(
								new Error(
									'terminating connection due to administrator command',
								),
								{ code: '57P01' },
							),
						);
					} catch (error) {
						escaped.push(String(error));
					}
				});
			}
			async query(): Promise<never> {
				throw new Error(
					'Client has encountered a connection error and is not queryable',
				);
			}
			end(callback?: () => void): void {
				this._ending = true;
				callback?.();
			}
		}
		const databases = postgresProvider(
			(options) =>
				new Pool({ ...options, Client: SameReadFatalClient as never }),
			'postgres://flowdular@db.invalid/flowdular',
		);
		const lease = await databases.acquire({
			namespace: 'connection-loss.core',
			purpose: 'migration',
		});
		try {
			await expect(lease.database.query({ text: 'SELECT 1' })).rejects.toThrow(
				'not queryable',
			);
			expect(escaped).toEqual([]);
		} finally {
			await lease.release();
			await databases.dispose();
		}
	});
});

describe.skipIf(!migratorUrl)('PostgreSQL connection loss', () => {
	it('logs a closed idle connection once without credentials and reconnects', async () => {
		const uncaught = recordUncaughtExceptions();
		let reported!: () => void;
		const firstReport = new Promise<void>((resolve) => {
			reported = resolve;
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => reported());
		const databases = postgresProvider();
		const lease = await databases.acquire({
			namespace: 'connection-loss.core',
			purpose: 'migration',
		});
		try {
			const closed = await backendPid(lease.database);
			await terminateBackend(closed);
			await Promise.race([firstReport, uncaught.first]);
			expect(uncaught.messages).toEqual([]);

			const reopened = await backendPid(lease.database);
			expect(reopened).not.toBe(closed);
			expect(warn).toHaveBeenCalledTimes(1);
			const output = inspect(warn.mock.calls, { depth: 10 });
			const url = new URL(migratorUrl!);
			expect(output).not.toContain(migratorUrl);
			expect(output).not.toContain(decodeURIComponent(url.username));
			if (url.password) {
				expect(output).not.toContain(decodeURIComponent(url.password));
			}
		} finally {
			await lease.release();
			await databases.dispose();
			warn.mockRestore();
			uncaught.stop();
		}
	});

	it('fails only the transaction whose query was running when its connection closed', async () => {
		const uncaught = recordUncaughtExceptions();
		const databases = postgresProvider();
		const lease = await databases.acquire({
			namespace: 'connection-loss.core',
			purpose: 'migration',
		});
		try {
			await expect(
				lease.database.transaction(async (transaction) => {
					const pid = await backendPid(transaction);
					const terminated = terminateBackend(pid, { whileRunning: true });
					try {
						await transaction.query({ text: 'SELECT pg_sleep(10)' });
					} finally {
						await terminated;
					}
				}),
			).rejects.toMatchObject({ code: '57P01' });
			expect(uncaught.messages).toEqual([]);

			await expect(backendPid(lease.database)).resolves.toBeGreaterThan(0);
		} finally {
			await lease.release();
			await databases.dispose();
			uncaught.stop();
		}
	});

	it('fails only the transaction whose connection closed between its queries', async () => {
		const uncaught = recordUncaughtExceptions();
		const databases = postgresProvider();
		const lease = await databases.acquire({
			namespace: 'connection-loss.core',
			purpose: 'migration',
		});
		try {
			await expect(
				lease.database.transaction(async (transaction) => {
					await terminateBackend(await backendPid(transaction));
					await transaction.query({ text: 'SELECT 1' });
				}),
			).rejects.toThrow();
			expect(uncaught.messages).toEqual([]);

			await expect(backendPid(lease.database)).resolves.toBeGreaterThan(0);
		} finally {
			await lease.release();
			await databases.dispose();
			uncaught.stop();
		}
	});
});
