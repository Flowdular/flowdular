import type {
	ModuleSettingRecord,
	ModuleSettingValue,
	ModuleSettingsStore,
} from '@flowdular/kernel';
import type { AuthRepository } from './repository.ts';

export interface AuthSettingsStore extends ModuleSettingsStore {
	/**
	 * Resolves once every snapshot and write requested so far has reached the
	 * database, and rejects once with the first failure since the last call.
	 */
	ready(): Promise<void>;
	/** Loads one snapshot and waits for it, so a later read cannot miss it. */
	prime(tenantId: string, moduleId: string): Promise<void>;
}

/**
 * The kernel settings runtime reads through a synchronous store and caches the
 * object it gets back. auth.core now stores settings in PostgreSQL, which is
 * asynchronous, so this store hands out the snapshot object for one tenant and
 * module and fills that same object when the read resolves: the runtime's
 * cached reference sees the values without a second call. Until the first read
 * lands a declared default is what a caller sees, so anything that must not
 * observe that window primes the snapshot first. Writes apply to the snapshot
 * immediately and reach the database in call order.
 */
export function createAuthSettingsStore(
	repository: () => Promise<AuthRepository>,
): AuthSettingsStore {
	const snapshots = new Map<string, Record<string, ModuleSettingValue>>();
	let queue: Promise<void> = Promise.resolve();
	let failure: unknown;

	const enqueue = (work: () => Promise<void>, label: string): void => {
		queue = queue.then(async () => {
			try {
				await work();
			} catch (error) {
				/* The kernel write path is synchronous and returns nothing, so this
				   is the only place a failure can be reported. The value never
				   reaches the log; a stored secret would end up in it. */
				failure ??= error;
				console.error(`[auth.core] module settings ${label} failed`);
			}
		});
	};

	const snapshot = (
		tenantId: string,
		moduleId: string,
	): Record<string, ModuleSettingValue> => {
		const key = `${tenantId} ${moduleId}`;
		const existing = snapshots.get(key);
		if (existing) return existing;
		const values: Record<string, ModuleSettingValue> = {};
		snapshots.set(key, values);
		enqueue(async () => {
			const store = await repository();
			Object.assign(values, await store.loadSettings(tenantId, moduleId));
		}, `read of ${moduleId}`);
		return values;
	};

	return {
		load: snapshot,
		save(record: ModuleSettingRecord) {
			snapshot(record.tenantId, record.moduleId)[record.key] = record.value;
			enqueue(
				async () => (await repository()).saveSetting(record),
				`write of ${record.moduleId}.${record.key}`,
			);
		},
		clear(tenantId: string, moduleId: string, key: string) {
			delete snapshot(tenantId, moduleId)[key];
			enqueue(
				async () => (await repository()).clearSetting(tenantId, moduleId, key),
				`clear of ${moduleId}.${key}`,
			);
		},
		async ready() {
			await queue;
			const pending = failure;
			failure = undefined;
			if (pending !== undefined) throw pending;
		},
		async prime(tenantId: string, moduleId: string) {
			snapshot(tenantId, moduleId);
			await this.ready();
		},
	};
}
