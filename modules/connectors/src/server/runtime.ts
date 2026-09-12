import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import {
	createConnectorDefinitionRegistry,
	type ConnectorDefinitionRegistry,
} from '../domain/definitions.ts';
import { HTTP_JSON_DEFINITION } from '../domain/http-json.ts';
import {
	ConnectorCallService,
	type ConnectorCallLimits,
	type ConnectorConnectSeam,
} from '../services/call-service.ts';
import { ConnectorsService } from '../services/connectors-service.ts';
import {
	credentialVaultFromEnvironment,
	type CredentialVault,
} from '../services/credential-vault.ts';
import {
	DatabaseConnectorsRepository,
	migrateConnectorsDatabase,
} from '../services/database-repository.ts';
import type { HostAddressResolver } from '../services/egress.ts';
import type { ConnectorsRepository } from '../services/repository.ts';

export interface ConnectorsRuntimeOptions {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	readonly purpose?:
		| Exclude<DatabaseProviderRequest['purpose'], 'migration'>
		| undefined;
	readonly environment?: NodeJS.ProcessEnv;
	readonly workspaceRoot?: string;
	readonly vault?: CredentialVault;
	/** Live platform settings, read again for every call. */
	readonly limits: () => ConnectorCallLimits;
	readonly repository?: ConnectorsRepository;
	/** Test seam for the address check; never reachable from configuration. */
	readonly hostResolver?: HostAddressResolver | undefined;
	/** Test seam for the outbound socket; never reachable from configuration. */
	readonly connect?: ConnectorConnectSeam | undefined;
	readonly now?: () => number;
}

export interface ConnectorsRuntime {
	/** Registered while modules compose, before the first read seals it. */
	readonly definitions: ConnectorDefinitionRegistry;
	/** Opened on first use. The data class operations run on this store. */
	repository(): Promise<ConnectorsRepository>;
	service(): Promise<ConnectorsService>;
	calls(): Promise<ConnectorCallService>;
	dispose(): Promise<void>;
}

export function createConnectorsRuntime(
	options: ConnectorsRuntimeOptions,
): ConnectorsRuntime {
	const environment = options.environment ?? process.env;
	const workspaceRoot = options.workspaceRoot ?? process.cwd();
	const definitions = createConnectorDefinitionRegistry();
	/* The platform ships the generic connector, so a workspace has one kind
	   before any module registers its own. */
	definitions.register(HTTP_JSON_DEFINITION);
	let disposed = false;
	let repositoryPromise: Promise<ConnectorsRepository> | undefined;
	let leases: readonly DatabaseAdapterLease[] = [];
	let instances: ConnectorsService | undefined;
	let callService: ConnectorCallService | undefined;

	const openRepository = async (): Promise<ConnectorsRepository> => {
		if (options.repository) return options.repository;
		/* Schema work runs on the migrator role and that lease is released before
		   the runtime one is taken, so request handling never holds a schema owner. */
		const migration = await options.databases.acquire({
			namespace: 'connectors.core',
			purpose: 'migration',
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [
					DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
					DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
					DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
				],
			},
		});
		try {
			await migrateConnectorsDatabase(migration.database);
		} finally {
			await migration.release();
		}
		const runtimeLease = await options.databases.acquire({
			namespace: 'connectors.core',
			purpose: options.purpose ?? 'runtime',
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
			},
		});
		leases = [runtimeLease];
		return new DatabaseConnectorsRepository(runtimeLease.database);
	};

	const repository = (): Promise<ConnectorsRepository> => {
		if (disposed) {
			return Promise.reject(new Error('Connectors runtime is disposed.'));
		}
		repositoryPromise ??= openRepository();
		return repositoryPromise;
	};

	const vault =
		options.vault ?? credentialVaultFromEnvironment(environment, workspaceRoot);

	return {
		definitions,
		repository,
		async calls() {
			const store = await repository();
			callService ??= new ConnectorCallService({
				repository: store,
				vault,
				definitions: () => definitions,
				limits: options.limits,
				hostResolver: options.hostResolver,
				connect: options.connect,
				...(options.now ? { now: options.now } : {}),
			});
			return callService;
		},
		async service() {
			const store = await repository();
			const calls = await this.calls();
			instances ??= new ConnectorsService({
				repository: store,
				vault,
				definitions: () => definitions,
				hostResolver: options.hostResolver,
				/* A changed credential, a withdrawn consent or a disabled instance
				   must not keep working from a token this process already holds. */
				invalidate: (tenantId, instanceId) =>
					calls.forget(tenantId, instanceId),
				...(options.now ? { now: options.now } : {}),
			});
			return instances;
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			const open = leases;
			leases = [];
			repositoryPromise = undefined;
			instances = undefined;
			callService = undefined;
			for (const lease of open) await lease.release();
		},
	};
}
