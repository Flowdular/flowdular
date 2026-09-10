import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/sdk/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/sdk/database';
import {
	DatabaseNoteRepository,
	migrateExampleDatabase,
} from '../services/database-repository.ts';
import { NoteService } from '../services/note-service.ts';

export interface ExampleRuntimeOptions {
	readonly databases: DatabaseProvider;
	readonly purpose: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
}

export interface ExampleRuntime {
	service(): Promise<NoteService>;
	dispose(): Promise<void>;
}

export function createExampleRuntime(
	options: ExampleRuntimeOptions,
): ExampleRuntime {
	let disposed = false;
	let runtimeLeasePromise: Promise<DatabaseAdapterLease> | undefined;
	let servicePromise: Promise<NoteService> | undefined;

	const initialize = async (): Promise<NoteService> => {
		const migrationLease = await options.databases.acquire({
			namespace: 'example.core',
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
			await migrateExampleDatabase(migrationLease.database);
		} finally {
			await migrationLease.release();
		}
		runtimeLeasePromise = options.databases.acquire({
			namespace: 'example.core',
			purpose: options.purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
			},
		});
		const lease = await runtimeLeasePromise;
		return new NoteService(new DatabaseNoteRepository(lease.database));
	};

	return {
		service: () => {
			if (disposed) {
				return Promise.reject(new Error('Example runtime is disposed.'));
			}
			servicePromise ??= initialize();
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
