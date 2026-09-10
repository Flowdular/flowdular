import { flowdularStateDirectory } from '@flowdular/kernel/runtime-config';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	createDatabaseAdapterRegistry,
	databaseProviderConfigFromEnvironment,
	DATABASE_ADAPTER_IDS,
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapter,
	type DatabaseAdapterConnectionInput,
	type DatabaseAdapterDescriptor,
	type DatabaseAdapterId,
	type DatabaseAdapterLease,
	type DatabaseAdapterProbeResult,
	type DatabaseAdapterRegistry,
	type DatabaseAdapterState,
	type DatabaseAdapterValidationIssue,
	type DatabaseRow,
	type DatabaseTransaction,
} from '@flowdular/database';
import {
	createPlatformDatabaseProvider,
	type PlatformDatabaseProvider,
} from '../database.ts';
import { classifySetupFailure, SetupProbeError } from './sanitize.ts';

export const PGLITE_ADAPTER_ID = 'flowdular.pglite';
export const POSTGRESQL_ADAPTER_ID = DATABASE_ADAPTER_IDS.postgresql;

const PROBE_TIMEOUT_MS = 5_000;
const SETUP_NAMESPACE = 'flowdular.setup';

/* Mirrors what PostgresDatabaseAdapter advertises. Both first-run options run
   that adapter, so the embedded database enforces the same forced row-level
   security a server does; the readiness check proves it at runtime. */
const POSTGRES_PROFILE = Object.freeze({
	features: Object.freeze([
		DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
		DATABASE_CAPABILITY_IDS.RETURNING,
		DATABASE_CAPABILITY_IDS.ROW_LEVEL_SECURITY,
		DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
		DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
		DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
		DATABASE_CAPABILITY_IDS.TRANSACTIONS,
	]),
	isolationLevels: Object.freeze([
		'read-committed',
		'repeatable-read',
		'serializable',
	] as const),
});

export interface SetupAdapterOptions {
	readonly workspaceRoot: string;
	readonly production: boolean;
}

/**
 * A registered adapter plus the two things the platform, not the contract,
 * owns: the environment a deployment needs so this adapter becomes its
 * database, and a provider built from that same environment.
 */
export interface PlatformSetupAdapter {
	readonly descriptor: DatabaseAdapterDescriptor;
	environment(input: DatabaseAdapterConnectionInput): Record<string, string>;
	openProvider(input: DatabaseAdapterConnectionInput): PlatformDatabaseProvider;
}

export interface SetupAdapters {
	readonly registry: DatabaseAdapterRegistry;
	get(adapterId: string): PlatformSetupAdapter | undefined;
	list(): readonly PlatformSetupAdapter[];
}

function text(
	input: DatabaseAdapterConnectionInput,
	key: string,
): string | undefined {
	const value = input.config[key];
	if (typeof value === 'string') return value.trim() || undefined;
	if (typeof value === 'number') return String(value);
	return undefined;
}

function secret(
	input: DatabaseAdapterConnectionInput,
	key: string,
): string | undefined {
	return input.secrets[key] || undefined;
}

export function setupSecretValues(
	input: DatabaseAdapterConnectionInput,
): readonly string[] {
	return Object.values(input.secrets).filter((value) => value.length > 0);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		work,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new SetupProbeError('TIMED_OUT')),
				timeoutMs,
			);
			timer.unref?.();
		}),
	]).finally(() => clearTimeout(timer));
}

/* A leased runtime handle presented as the adapter the descriptor contract
   returns. Disposing it releases the lease and closes every pool the
   configuration opened, so a probe leaves no connection behind. */
function leasedAdapter(
	provider: PlatformDatabaseProvider,
	lease: DatabaseAdapterLease,
): DatabaseAdapter {
	const handle = lease.database;
	let state: DatabaseAdapterState = 'ready';
	return {
		get state() {
			return state;
		},
		adapterId: handle.adapterId,
		dialectId: handle.dialectId,
		capabilities: handle.capabilities,
		schema: handle.schema,
		query<Row extends DatabaseRow = DatabaseRow>(
			statement: Parameters<typeof handle.query>[0],
			options?: Parameters<typeof handle.query>[1],
		) {
			return handle.query<Row>(statement, options);
		},
		execute: (statement, options) => handle.execute(statement, options),
		executeScript: (script, options) => handle.executeScript(script, options),
		transaction<T>(
			operation: (transaction: DatabaseTransaction) => Promise<T>,
			options?: Parameters<typeof handle.transaction>[1],
		) {
			return handle.transaction(operation, options);
		},
		async dispose() {
			if (state !== 'ready') return;
			state = 'disposing';
			try {
				await lease.release();
				await provider.dispose();
			} finally {
				state = 'disposed';
			}
		},
	};
}

/* Reachability is answered by the provider's own readiness check, which
   already refuses a runtime role holding SUPERUSER or BYPASSRLS, plus a
   background lease because auth.core takes one on its first request. A
   deployment that cannot serve one would boot and then fail. */
async function probeProvider(
	adapter: PlatformSetupAdapter,
	input: DatabaseAdapterConnectionInput,
): Promise<DatabaseAdapterProbeResult> {
	const started = Date.now();
	let provider: PlatformDatabaseProvider | undefined;
	try {
		provider = adapter.openProvider(input);
		const opened = provider;
		await withTimeout(
			(async () => {
				await opened.check();
				const background = await opened.acquire({
					namespace: SETUP_NAMESPACE,
					purpose: 'background',
				});
				await background.release();
			})(),
			PROBE_TIMEOUT_MS,
		);
		return { status: 'ready', latencyMs: Date.now() - started };
	} catch (error) {
		return {
			status: 'unavailable',
			latencyMs: Date.now() - started,
			message: classifySetupFailure(error, setupSecretValues(input)).message,
		};
	} finally {
		await provider?.dispose().catch(() => undefined);
	}
}

async function connectProvider(
	adapter: PlatformSetupAdapter,
	input: DatabaseAdapterConnectionInput,
): Promise<DatabaseAdapter> {
	const provider = adapter.openProvider(input);
	try {
		const lease = await provider.acquire({
			namespace: SETUP_NAMESPACE,
			purpose: 'runtime',
		});
		return leasedAdapter(provider, lease);
	} catch (error) {
		await provider.dispose().catch(() => undefined);
		throw error;
	}
}

function issue(
	field: string,
	code: string,
	message: string,
): DatabaseAdapterValidationIssue {
	return { field, code, message };
}

const HOST = /^[A-Za-z0-9._:[\]-]{1,255}$/;
const IDENTIFIER = /^[A-Za-z0-9_$-]{1,63}$/;
const TLS_MODES = ['verify-full', 'require', 'disable'] as const;

function dsn(
	input: DatabaseAdapterConnectionInput,
	user: string,
	password: string,
): string {
	const host = text(input, 'host') ?? '';
	const port = text(input, 'port') ?? '5432';
	const database = text(input, 'database') ?? '';
	return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(
		password,
	)}@${host}:${port}/${encodeURIComponent(database)}`;
}

function createPostgresqlAdapter(
	options: SetupAdapterOptions,
): PlatformSetupAdapter {
	const adapter: PlatformSetupAdapter = {
		descriptor: {
			adapterId: POSTGRESQL_ADAPTER_ID,
			dialectId: DATABASE_DIALECT_IDS.postgresql,
			label: 'PostgreSQL server',
			description:
				'A PostgreSQL server you already run. The deployment connects with three roles: one that owns the schema, one tenant-scoped role that serves requests, and one read-only role for the few cross-tenant lookups.',
			capabilities: POSTGRES_PROFILE,
			configurationSchema: {
				version: 1,
				fields: [
					{
						key: 'host',
						label: 'Host',
						description: 'Host name or address of the PostgreSQL server.',
						kind: 'text',
						required: true,
						secret: false,
					},
					{
						key: 'port',
						label: 'Port',
						description: 'Port the server listens on.',
						kind: 'integer',
						required: true,
						secret: false,
					},
					{
						key: 'database',
						label: 'Database',
						description: 'An existing, empty database this deployment owns.',
						kind: 'text',
						required: true,
						secret: false,
					},
					{
						key: 'migrator-user',
						label: 'Migration role',
						description:
							'Owns the schema. Used only while migrations run, never to serve a request.',
						kind: 'text',
						required: true,
						secret: false,
					},
					{
						key: 'migrator-password',
						label: 'Migration role password',
						description: 'Password for the migration role.',
						kind: 'text',
						required: true,
						secret: true,
					},
					{
						key: 'runtime-user',
						label: 'Runtime role',
						description:
							'Serves every request. It must hold neither SUPERUSER nor BYPASSRLS, because tenant isolation depends on that.',
						kind: 'text',
						required: true,
						secret: false,
					},
					{
						key: 'runtime-password',
						label: 'Runtime role password',
						description: 'Password for the runtime role.',
						kind: 'text',
						required: true,
						secret: true,
					},
					{
						key: 'background-user',
						label: 'Background role',
						description:
							'Reads the routing columns a scheduler poll needs across tenants. It writes nothing.',
						kind: 'text',
						required: true,
						secret: false,
					},
					{
						key: 'background-password',
						label: 'Background role password',
						description: 'Password for the background role.',
						kind: 'text',
						required: true,
						secret: true,
					},
					{
						key: 'tls',
						label: 'TLS',
						description: options.production
							? 'A production deployment verifies the server certificate in full.'
							: 'How this deployment verifies the server certificate.',
						kind: 'select',
						required: true,
						secret: false,
						options: (options.production
							? (['verify-full'] as const)
							: TLS_MODES
						).map((mode) => ({ label: mode, value: mode })),
					},
					{
						key: 'tls-authority-file',
						label: 'Certificate authority file',
						description:
							'Path to a PEM certificate authority, when the server presents a certificate this machine does not already trust.',
						kind: 'text',
						required: false,
						secret: false,
					},
				],
			},
			validate(input) {
				const issues: DatabaseAdapterValidationIssue[] = [];
				const host = text(input, 'host');
				if (!host || !HOST.test(host)) {
					issues.push(
						issue('host', 'INVALID', 'Enter a host name or an address.'),
					);
				}
				const port = Number(text(input, 'port'));
				if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
					issues.push(
						issue('port', 'INVALID', 'Enter a port between 1 and 65535.'),
					);
				}
				const database = text(input, 'database');
				if (!database || !IDENTIFIER.test(database)) {
					issues.push(
						issue('database', 'INVALID', 'Enter an existing database name.'),
					);
				}
				for (const role of ['migrator', 'runtime', 'background'] as const) {
					const user = text(input, `${role}-user`);
					if (!user || !IDENTIFIER.test(user)) {
						issues.push(
							issue(`${role}-user`, 'INVALID', 'Enter the role name.'),
						);
					}
					if (!secret(input, `${role}-password`)) {
						issues.push(
							issue(
								`${role}-password`,
								'REQUIRED',
								'Enter the password for this role.',
							),
						);
					}
				}
				const migrator = text(input, 'migrator-user');
				const runtime = text(input, 'runtime-user');
				if (migrator && runtime && migrator === runtime) {
					issues.push(
						issue(
							'runtime-user',
							'INVALID',
							'The runtime role must differ from the migration role, so a request can never run schema operations.',
						),
					);
				}
				const tls = text(input, 'tls');
				if (!tls || !TLS_MODES.includes(tls as (typeof TLS_MODES)[number])) {
					issues.push(issue('tls', 'INVALID', 'Choose how TLS is verified.'));
				} else if (options.production && tls !== 'verify-full') {
					issues.push(
						issue(
							'tls',
							'INVALID',
							'A production deployment requires full certificate verification.',
						),
					);
				}
				return issues;
			},
			probe: (input) => probeProvider(adapter, input),
			async provision(_input, authorization) {
				if (authorization.intent !== 'confirmed-first-run') {
					throw new Error('Provisioning requires a confirmed first run.');
				}
				/* The server, the database, and the three roles belong to the
				   operator. Creating them would need a superuser credential this
				   screen deliberately never asks for. */
			},
			connect: (input) => connectProvider(adapter, input),
		},
		environment(input) {
			const authority = text(input, 'tls-authority-file');
			return {
				FD_DATABASE_ADAPTER: 'postgresql',
				FD_DATABASE_URL: dsn(
					input,
					text(input, 'runtime-user') ?? '',
					secret(input, 'runtime-password') ?? '',
				),
				FD_DATABASE_MIGRATOR_URL: dsn(
					input,
					text(input, 'migrator-user') ?? '',
					secret(input, 'migrator-password') ?? '',
				),
				FD_DATABASE_BACKGROUND_URL: dsn(
					input,
					text(input, 'background-user') ?? '',
					secret(input, 'background-password') ?? '',
				),
				FD_DATABASE_TLS: text(input, 'tls') ?? 'verify-full',
				...(authority ? { FD_DATABASE_TLS_CA_FILE: authority } : {}),
			};
		},
		openProvider(input) {
			return createPlatformDatabaseProvider(
				databaseProviderConfigFromEnvironment(
					{
						NODE_ENV: options.production ? 'production' : 'development',
						FD_DATABASE_CONNECT_TIMEOUT_MS: String(PROBE_TIMEOUT_MS),
						...adapter.environment(input),
					},
					options.workspaceRoot,
				),
			);
		},
	};
	return adapter;
}

function createPgliteAdapter(
	options: SetupAdapterOptions,
): PlatformSetupAdapter {
	const defaultDirectory = resolve(
		flowdularStateDirectory(options.workspaceRoot),
		'data',
		'pglite',
	);
	const directoryOf = (input: DatabaseAdapterConnectionInput): string =>
		resolve(
			options.workspaceRoot,
			text(input, 'data-directory') ?? defaultDirectory,
		);
	const adapter: PlatformSetupAdapter = {
		descriptor: {
			adapterId: PGLITE_ADAPTER_ID,
			dialectId: DATABASE_DIALECT_IDS.postgresql,
			label: 'Embedded PostgreSQL',
			description:
				'PostgreSQL running inside this process, storing its data in a directory on this machine. Nothing to install and no credentials to manage; it enforces the same forced row-level security a server does.',
			capabilities: POSTGRES_PROFILE,
			configurationSchema: {
				version: 1,
				fields: [
					{
						key: 'data-directory',
						label: 'Data directory',
						description:
							'Where the database files live. Leave it empty to use the default below.',
						kind: 'text',
						required: false,
						secret: false,
					},
				],
			},
			validate(input) {
				const directory = text(input, 'data-directory');
				if (directory && /[\0]/.test(directory)) {
					return [
						issue('data-directory', 'INVALID', 'Enter a directory path.'),
					];
				}
				return [];
			},
			probe: (input) => probeProvider(adapter, input),
			async provision(input, authorization) {
				if (authorization.intent !== 'confirmed-first-run') {
					throw new Error('Provisioning requires a confirmed first run.');
				}
				/* The only external state this adapter owns is its data directory,
				   and the database files inside it must not be world readable. */
				mkdirSync(directoryOf(input), { recursive: true, mode: 0o700 });
			},
			connect: (input) => connectProvider(adapter, input),
		},
		environment: (input) => ({
			FD_DATABASE_ADAPTER: 'pglite',
			FD_DATABASE_PGLITE_DIRECTORY: directoryOf(input),
		}),
		openProvider(input) {
			return createPlatformDatabaseProvider(
				databaseProviderConfigFromEnvironment(
					{ NODE_ENV: 'development', ...adapter.environment(input) },
					options.workspaceRoot,
				),
			);
		},
	};
	return adapter;
}

/**
 * The adapters this deployment can be pointed at on a first run. The embedded
 * database is absent in production: a deployment states its real database
 * instead of shipping one inside the process.
 */
export function createSetupAdapters(
	options: SetupAdapterOptions,
): SetupAdapters {
	const registry = createDatabaseAdapterRegistry();
	const adapters = new Map<DatabaseAdapterId, PlatformSetupAdapter>();
	const register = (adapter: PlatformSetupAdapter): void => {
		registry.register(adapter.descriptor);
		adapters.set(adapter.descriptor.adapterId, adapter);
	};
	if (!options.production) register(createPgliteAdapter(options));
	register(createPostgresqlAdapter(options));
	registry.seal();
	return {
		registry,
		get: (adapterId) => adapters.get(adapterId),
		list: () => [...adapters.values()],
	};
}
