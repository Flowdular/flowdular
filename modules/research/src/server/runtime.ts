import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import { createConnectorAdapter } from '../adapters/connector.ts';
import { createFirecrawlAdapter } from '../adapters/firecrawl.ts';
import { createModelNativeAdapter } from '../adapters/model-native.ts';
import { createRecordedAdapter } from '../adapters/recorded.ts';
import { createSearxngAdapter } from '../adapters/searxng.ts';
import { RESEARCH_MODULE_ID, type ResearchSettings } from '../domain/types.ts';
import {
	ResearchAdapterAdmin,
	type ResearchSettingWriter,
} from '../services/adapter-admin.ts';
import type { ChainRuntime } from '../services/adapter-chain.ts';
import type {
	ConnectorCalls,
	ConnectorEgress,
	ConnectorInstances,
	MeterRegistry,
} from '../services/capabilities.ts';
import {
	DatabaseResearchRepository,
	migrateResearchDatabase,
} from '../services/database-repository.ts';
import {
	httpsPageTransport,
	type PageTransport,
} from '../services/page-transport.ts';
import type { ResearchRepository } from '../services/repository.ts';
import { ResearchService } from '../services/research-service.ts';
import type { RobotsCache } from '../services/robots.ts';

export interface ResearchRuntimeOptions {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	readonly purpose: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
	readonly settings: (tenantId: string) => Promise<ResearchSettings>;
	/** Where a relative recorded fixtures path is resolved. */
	readonly workspaceRoot: string;
	/* Resolved at the point of use, so an optional provider composed after this
	   module is found and an absent one answers its stable refusal. */
	readonly calls?: () => ConnectorCalls | undefined;
	readonly instances?: () => ConnectorInstances | undefined;
	readonly egress?: () => ConnectorEgress | undefined;
	readonly meters?: () => MeterRegistry | undefined;
	/** Writes one research setting as the owner; absent where no settings runtime exists. */
	readonly writeSetting?: ResearchSettingWriter;
	readonly chain?: ChainRuntime;
	/** Test seam for the socket; a deployment uses the pinned https transport. */
	readonly transport?: PageTransport;
	readonly robots?: RobotsCache;
	readonly now?: () => number;
	/** Supplied by tests that own the lease themselves. */
	readonly repository?: ResearchRepository;
}

export interface ResearchRuntime {
	service(): Promise<ResearchService>;
	readonly admin: ResearchAdapterAdmin;
	dispose(): Promise<void>;
}

export function createResearchRuntime(
	options: ResearchRuntimeOptions,
): ResearchRuntime {
	let disposed = false;
	let runtimeLeasePromise: Promise<DatabaseAdapterLease> | undefined;
	let servicePromise: Promise<ResearchService> | undefined;

	const calls = options.calls ?? (() => undefined);
	const instances = options.instances ?? (() => undefined);
	const build = (repository: ResearchRepository): ResearchService =>
		new ResearchService({
			repository,
			settings: options.settings,
			adapters: {
				modelNative: createModelNativeAdapter(repository),
				searxng: createSearxngAdapter({ calls, instances }),
				firecrawl: createFirecrawlAdapter({ calls, instances }),
				connector: createConnectorAdapter(calls),
				recorded: createRecordedAdapter(options.workspaceRoot),
			},
			egress: options.egress ?? (() => undefined),
			meters: options.meters ?? (() => undefined),
			transport: options.transport ?? httpsPageTransport(),
			...(options.robots ? { robots: options.robots } : {}),
			...(options.now ? { now: options.now } : {}),
			...(options.chain ? { chain: options.chain } : {}),
		});

	/* Schema work runs on the migrator role and that lease is released before
	   the runtime one is taken, so request handling never holds a schema owner. */
	const initialize = async (): Promise<ResearchService> => {
		if (options.repository) return build(options.repository);
		const migrationLease = await options.databases.acquire({
			namespace: RESEARCH_MODULE_ID,
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
			await migrateResearchDatabase(migrationLease.database);
		} finally {
			await migrationLease.release();
		}
		runtimeLeasePromise = options.databases.acquire({
			namespace: RESEARCH_MODULE_ID,
			purpose: options.purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [
					DATABASE_CAPABILITY_IDS.TRANSACTIONS,
					DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
				],
			},
		});
		const lease = await runtimeLeasePromise;
		return build(new DatabaseResearchRepository(lease.database));
	};

	const service = (): Promise<ResearchService> => {
		if (disposed) {
			return Promise.reject(new Error('Research runtime is disposed.'));
		}
		servicePromise ??= initialize();
		return servicePromise;
	};

	return {
		service,
		admin: new ResearchAdapterAdmin({
			service,
			settings: options.settings,
			writeSetting: options.writeSetting,
			instances,
			calls,
			egress: options.egress ?? (() => undefined),
			...(options.now ? { now: options.now } : {}),
		}),
		async dispose() {
			if (disposed) return;
			disposed = true;
			if (!runtimeLeasePromise) {
				await servicePromise?.catch(() => undefined);
			}
			if (!runtimeLeasePromise) return;
			const lease = await runtimeLeasePromise;
			await lease.release();
			runtimeLeasePromise = undefined;
			servicePromise = undefined;
		},
	};
}
