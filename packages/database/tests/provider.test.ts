import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
	createDatabaseProvider,
	databaseProviderConfigFromEnvironment,
} from '../src/index.ts';

const scratch = mkdtempSync(join(tmpdir(), 'flowdular-provider-'));

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

/* Disposal waits for every lease before closing a pool, because closing under an
   open query is worse than a slow shutdown. A lease that is never released must
   not turn that wait into silence: a CLI command that leaked one ended on an
   unsettled top-level await with no message, which reads as a hang. */
describe('lease drain on dispose', () => {
	it('closes and names the holders when a lease is never released', async () => {
		const error = vi
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		try {
			const provider = createDatabaseProvider(
				databaseProviderConfigFromEnvironment(productionEnvironment(), scratch),
				{
					postgresPool: () => ({
						async connect() {
							return {
								async query() {
									return { rows: [], rowCount: 0 };
								},
								release() {},
							};
						},
						async end() {},
					}),
				},
			);
			const lease = await provider.acquire({
				namespace: 'leaky.core',
				purpose: 'runtime',
				requirements: { dialectIds: ['postgresql' as never] },
			});
			expect(lease.database).toBeDefined();
			/* Deliberately not released. */
			const started = Date.now();
			await provider.dispose();
			expect(Date.now() - started).toBeLessThan(45_000);
			const reported = error.mock.calls.flat().join(' ');
			expect(reported).toContain('lease(s) still held');
			expect(reported).toContain('leaky.core:runtime');
		} finally {
			error.mockRestore();
		}
	}, 60_000);
});

/* node-postgres reports a connection the server closed as an `error` event: on
   the pool for an idle client, on the client while it is leased. Node ends the
   process on an `error` event nobody listens for. */
describe('connection errors from an event-emitting driver', () => {
	function emittingClient() {
		return Object.assign(new EventEmitter(), {
			async query() {
				return { rows: [], rowCount: 0 };
			},
			release() {},
		});
	}

	function emittingPool(client = emittingClient()) {
		return Object.assign(new EventEmitter(), {
			async connect() {
				return client;
			},
			async end() {},
		});
	}

	it('reports an idle connection error by code and message only', async () => {
		const pools: ReturnType<typeof emittingPool>[] = [];
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const provider = createDatabaseProvider(
			databaseProviderConfigFromEnvironment(productionEnvironment(), scratch),
			{
				postgresPool: () => {
					const pool = emittingPool();
					pools.push(pool);
					return pool;
				},
			},
		);
		try {
			/* node-postgres attaches the closed client to the error it emits. */
			const closed = Object.assign(
				new Error('terminating connection due to administrator command'),
				{
					code: '57P01',
					client: { user: 'runtime', password: 'secret', host: 'db.example' },
				},
			);
			expect(() => pools[0]!.emit('error', closed)).not.toThrow();

			expect(warn).toHaveBeenCalledTimes(1);
			const output = inspect(warn.mock.calls, { depth: 10 });
			expect(output).toContain('57P01');
			expect(output).not.toContain('secret');
			expect(output).not.toContain('db.example');
		} finally {
			await provider.dispose();
			warn.mockRestore();
		}
	});

	it('keeps a leased client error from ending the process, lease after lease', async () => {
		const client = emittingClient();
		const provider = createDatabaseProvider(
			databaseProviderConfigFromEnvironment(productionEnvironment(), scratch),
			{ postgresPool: () => emittingPool(client) },
		);
		const lease = await provider.acquire({
			namespace: 'leased.core',
			purpose: 'migration',
		});
		try {
			for (let round = 0; round < 12; round += 1) {
				await lease.database.transaction(async () => {
					expect(() =>
						client.emit(
							'error',
							new Error('Connection terminated unexpectedly'),
						),
					).not.toThrow();
				});
			}
			expect(client.listenerCount('error')).toBeLessThanOrEqual(1);
		} finally {
			await lease.release();
			await provider.dispose();
		}
	});
});

function certificateFile(name: string, contents: string): string {
	const path = join(scratch, name);
	writeFileSync(path, contents);
	return path;
}

function productionEnvironment(
	override: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
	return {
		NODE_ENV: 'production',
		FD_DATABASE_ADAPTER: 'postgresql',
		FD_DATABASE_URL: 'postgresql://runtime:secret@db.example/flowdular',
		FD_DATABASE_MIGRATOR_URL:
			'postgresql://migrator:other-secret@db.example/flowdular',
		...override,
	};
}

describe('configured database provider', () => {
	it('keeps local development on the embedded PostgreSQL and production on a server', () => {
		expect(
			databaseProviderConfigFromEnvironment(
				{ NODE_ENV: 'development' },
				'/workspace',
			),
		).toMatchObject({ adapter: 'pglite', production: false });
		expect(
			databaseProviderConfigFromEnvironment(
				productionEnvironment(),
				'/workspace',
			),
		).toMatchObject({ adapter: 'postgresql', production: true });
	});

	it('reads the TLS authority from a mounted file or an inline value', () => {
		const pem =
			'-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
		const path = certificateFile('ca.crt', pem);

		expect(
			databaseProviderConfigFromEnvironment(
				productionEnvironment({ FD_DATABASE_TLS_CA_FILE: path }),
				'/workspace',
			).postgresql?.runtime.ssl,
		).toEqual({ rejectUnauthorized: true, ca: pem });
		expect(
			databaseProviderConfigFromEnvironment(
				productionEnvironment({ FD_DATABASE_TLS_CA: pem }),
				'/workspace',
			).postgresql?.runtime.ssl,
		).toEqual({ rejectUnauthorized: true, ca: pem.trim() });
	});

	it('refuses an ambiguous, missing, or non-certificate TLS authority', () => {
		const pem =
			'-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
		expect(() =>
			databaseProviderConfigFromEnvironment(
				productionEnvironment({
					FD_DATABASE_TLS_CA: pem,
					FD_DATABASE_TLS_CA_FILE: certificateFile('both.crt', pem),
				}),
				'/workspace',
			),
		).toThrow('not both');
		expect(() =>
			databaseProviderConfigFromEnvironment(
				productionEnvironment({
					FD_DATABASE_TLS_CA_FILE: join(scratch, 'absent.crt'),
				}),
				'/workspace',
			),
		).toThrow('could not be read');
		expect(() =>
			databaseProviderConfigFromEnvironment(
				productionEnvironment({
					FD_DATABASE_TLS_CA_FILE: certificateFile('key.pem', 'not a cert'),
				}),
				'/workspace',
			),
		).toThrow('PEM encoded certificate');
	});

	it('rejects incomplete or unsafe production PostgreSQL configuration', () => {
		expect(() =>
			databaseProviderConfigFromEnvironment(
				{ NODE_ENV: 'production' },
				'/workspace',
			),
		).toThrow('FD_DATABASE_URL');
		expect(() =>
			databaseProviderConfigFromEnvironment(
				productionEnvironment({ FD_DATABASE_MIGRATOR_URL: undefined }),
				'/workspace',
			),
		).toThrow('FD_DATABASE_MIGRATOR_URL');
		expect(() =>
			databaseProviderConfigFromEnvironment(
				productionEnvironment({ FD_DATABASE_TLS: 'disable' }),
				'/workspace',
			),
		).toThrow('verify-full');
		expect(() =>
			databaseProviderConfigFromEnvironment(
				productionEnvironment({
					FD_DATABASE_MIGRATOR_URL:
						'postgresql://runtime:secret@db.example/flowdular',
				}),
				'/workspace',
			),
		).toThrow('separate runtime and migrator credentials');
	});

	it('validates pool and timeout bounds before a connection starts', () => {
		expect(() =>
			databaseProviderConfigFromEnvironment(
				productionEnvironment({
					FD_DATABASE_POOL_MIN: '11',
					FD_DATABASE_POOL_MAX: '10',
				}),
				'/workspace',
			),
		).toThrow('FD_DATABASE_POOL_MIN');
		expect(() =>
			databaseProviderConfigFromEnvironment(
				productionEnvironment({
					FD_DATABASE_QUERY_TIMEOUT_MS: '1000',
					FD_DATABASE_STATEMENT_TIMEOUT_MS: '2000',
				}),
				'/workspace',
			),
		).toThrow('cannot be shorter');
	});
});

describe('configured database provider lifecycle', () => {
	it.each(['safe', 'superuser', 'bypassrls', 'unavailable'])(
		'checks the configured background role during readiness: %s',
		async (mode) => {
			const provider = createDatabaseProvider(
				databaseProviderConfigFromEnvironment(
					productionEnvironment({
						FD_DATABASE_BACKGROUND_URL:
							'postgresql://background@db.example/flowdular',
					}),
				),
				{
					postgresPool: (config) => {
						const background =
							new URL(config.connectionString!).username === 'background';
						return {
							async connect() {
								if (background && mode === 'unavailable')
									throw new Error('background unavailable');
								return {
									async query({ text }) {
										return {
											rows: text.includes('FROM pg_roles')
												? [
														{
															rolsuper: background && mode === 'superuser',
															rolbypassrls: background && mode === 'bypassrls',
														},
													]
												: [],
											rowCount: 0,
										};
									},
									release() {},
								};
							},
							async end() {},
						};
					},
				},
			);
			try {
				if (mode === 'safe') {
					await expect(provider.check()).resolves.toEqual({
						adapter: 'postgresql',
						status: 'ready',
					});
				} else {
					await expect(provider.check()).rejects.toThrow(
						mode === 'unavailable'
							? 'background unavailable'
							: 'background role must not be superuser or BYPASSRLS',
					);
				}
			} finally {
				await provider.dispose();
			}
		},
	);

	/* The package owns no driver, so a PostgreSQL deployment must hand one in
	   rather than discover at the first query that there is nothing to talk to. */
	it('refuses to build a PostgreSQL provider without a driver seam', () => {
		expect(() =>
			createDatabaseProvider({
				adapter: 'postgresql',
				production: false,
				workspaceRoot: '/workspace',
				environment: {},
			} as never),
		).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
	});

	it('uses separate real-driver seams for runtime and migration roles', async () => {
		const ended: string[] = [];
		const queries: { role: string; text: string; values?: unknown[] }[] = [];
		const poolFactory = vi.fn(
			(config: { connectionString?: string | undefined }) => {
				const role = config.connectionString?.includes('migrator')
					? 'migrator'
					: 'runtime';
				return {
					async connect() {
						return {
							async query(query: { text: string; values?: unknown[] }) {
								queries.push({ role, ...query });
								if (query.text.includes('FROM pg_roles')) {
									return {
										rows: [{ rolsuper: false, rolbypassrls: false }],
										rowCount: 1,
									};
								}
								return { rows: [], rowCount: 0 };
							},
							release() {},
						};
					},
					async end() {
						ended.push(role);
					},
				};
			},
		);
		const config = databaseProviderConfigFromEnvironment(
			productionEnvironment(),
			'/workspace',
		);
		const provider = createDatabaseProvider(config, {
			postgresPool: poolFactory,
		});

		await expect(provider.check()).resolves.toEqual({
			adapter: 'postgresql',
			status: 'ready',
		});
		const runtime = await provider.acquire({
			namespace: 'profile.core',
			purpose: 'runtime',
		});
		const migration = await provider.acquire({
			namespace: 'profile.core',
			purpose: 'migration',
		});
		await expect(
			runtime.database.query({ text: 'SELECT 1' }),
		).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
		await expect(
			migration.database.query({ text: 'SELECT 1' }),
		).resolves.toEqual({
			rows: [],
			rowCount: 0,
		});
		expect(JSON.stringify(provider)).not.toContain('secret');
		await runtime.release();
		await migration.release();
		await provider.dispose();

		expect(poolFactory).toHaveBeenCalledTimes(2);
		expect(queries.some((query) => query.text.includes('set_config'))).toBe(
			true,
		);
		expect(queries.some((query) => query.text.includes('pg_roles'))).toBe(true);
		expect(ended.sort()).toEqual(['migrator', 'runtime']);
	});

	it('rejects a privileged PostgreSQL runtime role during readiness', async () => {
		const provider = createDatabaseProvider(
			databaseProviderConfigFromEnvironment(
				productionEnvironment(),
				'/workspace',
			),
			{
				postgresPool: () => ({
					async connect() {
						return {
							async query(query) {
								return query.text.includes('FROM pg_roles')
									? {
											rows: [{ rolsuper: true, rolbypassrls: false }],
											rowCount: 1,
										}
									: { rows: [], rowCount: 0 };
							},
							release() {},
						};
					},
					async end() {},
				}),
			},
		);

		await expect(provider.check()).rejects.toThrow(
			'runtime role must not be superuser or BYPASSRLS',
		);
		await provider.dispose();
	});
});
