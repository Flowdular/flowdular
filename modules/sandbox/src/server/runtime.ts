import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import { directoryFromAuthRuntime } from '../services/directory.ts';
import { SandboxService } from '../services/sandbox-service.ts';
import {
	DatabaseSandboxRepository,
	migrateSandboxDatabase,
} from '../services/database-repository.ts';

export interface SandboxRuntimeSettings {
	/* Where the sandbox application is reachable. The platform only links to
	   it; it never proxies sandbox traffic. */
	readonly sandboxUrl: string;
}

export interface SandboxRuntimeOptions extends SandboxRuntimeSettings {
	readonly databases: DatabaseProvider;
	readonly purpose: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
}

export interface SandboxRuntime {
	readonly options: SandboxRuntimeOptions;
	service(auth: AuthRuntime): Promise<SandboxService>;
	dispose(): Promise<void>;
}

function sandboxUrl(value: string | undefined): string {
	const candidate = value?.trim() || 'http://127.0.0.1:4320';
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new Error('FD_SANDBOX_URL must be an absolute URL.');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('FD_SANDBOX_URL must use http or https.');
	}
	return url.origin;
}

export function sandboxSettingsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): SandboxRuntimeSettings {
	return { sandboxUrl: sandboxUrl(environment.FD_SANDBOX_URL) };
}

export function createSandboxRuntime(
	options: SandboxRuntimeOptions,
): SandboxRuntime {
	let disposed = false;
	let runtimeLeasePromise: Promise<DatabaseAdapterLease> | undefined;
	let servicePromise: Promise<SandboxService> | undefined;

	const initialize = async (auth: AuthRuntime): Promise<SandboxService> => {
		/* Migrations take their own short lease: the runtime role is tenant
		   scoped and may not run schema operations. */
		const migrationLease = await options.databases.acquire({
			namespace: 'sandbox.core',
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
			await migrateSandboxDatabase(migrationLease.database);
		} finally {
			await migrationLease.release();
		}
		runtimeLeasePromise = options.databases.acquire({
			namespace: 'sandbox.core',
			purpose: options.purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
			},
		});
		const lease = await runtimeLeasePromise;
		return new SandboxService(
			new DatabaseSandboxRepository(lease.database),
			directoryFromAuthRuntime(auth),
		);
	};

	return {
		options,
		service: (auth) => {
			if (disposed) {
				return Promise.reject(new Error('Sandbox runtime is disposed.'));
			}
			servicePromise ??= initialize(auth);
			return servicePromise;
		},
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
