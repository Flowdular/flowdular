import type { ComposedModule } from '../../src/domain/modules.ts';
import {
	createSystemRuntime,
	type SystemRuntime,
} from '../../src/server/runtime.ts';
import type {
	ModuleActivationRecord,
	ModuleActivationRepository,
} from '../../src/services/repository.ts';

/** An in-memory store, for suites that test the routes rather than the schema. */
export function memoryActivationRepository(): ModuleActivationRepository & {
	readonly records: Map<string, ModuleActivationRecord>;
} {
	const records = new Map<string, ModuleActivationRecord>();
	return {
		records,
		async list(tenantId) {
			return [...records.values()]
				.filter((record) => record.tenantId === tenantId)
				.sort((a, b) => a.moduleId.localeCompare(b.moduleId));
		},
		async set(record) {
			records.set(`${record.tenantId}\0${record.moduleId}`, record);
		},
	};
}

export function memoryActivationRuntime(
	modules: readonly ComposedModule[] = [],
	repository: ModuleActivationRepository = memoryActivationRepository(),
): SystemRuntime {
	return createSystemRuntime({
		databases: undefined as never,
		purpose: 'test',
		repository,
		modules: () => modules,
	});
}
