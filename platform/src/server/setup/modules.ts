import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type ModuleDatabaseRequirements,
} from '@flowdular/database';
import projectManifest from '../../../../flowdular.json';

/**
 * What every database-owning module in this repository asks its lease for. The
 * module manifest carries no machine-readable database block yet, so the
 * platform applies the strictest set any enabled module requests rather than
 * guessing a looser one per module. The precise fix is a `database` block in
 * packages/contracts/schemas/module.schema.json that each module fills in.
 */
export const PLATFORM_MODULE_DATABASE_REQUIREMENTS = Object.freeze({
	dialectIds: Object.freeze([DATABASE_DIALECT_IDS.postgresql]),
	capabilities: Object.freeze([
		DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
		DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
		DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
		DATABASE_CAPABILITY_IDS.TRANSACTIONS,
	]),
});

export interface EnabledDatabaseModules {
	readonly modules: readonly ModuleDatabaseRequirements[];
	/**
	 * True when the module manifests could not be read, so every enabled module
	 * is treated as owning tenant-scoped tables. Over-approximating keeps the
	 * check strict; the review screen says the list came from this fallback.
	 */
	readonly approximated: boolean;
}

interface ModuleManifest {
	readonly id?: unknown;
	readonly capabilities?: unknown;
	readonly tenancy?: unknown;
}

interface ProjectManifest {
	readonly modules?: {
		readonly roots?: unknown;
		readonly enabled?: unknown;
	};
}

function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as T;
	} catch {
		return null;
	}
}

function stringList(value: unknown): readonly string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string')
		: [];
}

function requirements(
	moduleId: string,
	tenantOwned: boolean,
): ModuleDatabaseRequirements {
	return {
		moduleId,
		tenantOwned,
		dialectIds: PLATFORM_MODULE_DATABASE_REQUIREMENTS.dialectIds,
		capabilities: PLATFORM_MODULE_DATABASE_REQUIREMENTS.capabilities,
	};
}

/**
 * The enabled modules that own database tables, in `flowdular.json` order.
 * A container image ships only `platform/dist`, so the enabled list falls back
 * to the manifest bundled at build time and, without the module manifests
 * beside it, every enabled module is assumed to own tenant-scoped tables.
 */
export function enabledDatabaseModules(
	workspaceRoot: string,
): EnabledDatabaseModules {
	const project =
		readJson<ProjectManifest>(resolve(workspaceRoot, 'flowdular.json')) ??
		(projectManifest as ProjectManifest);
	const enabled = stringList(project.modules?.enabled);
	if (enabled.length === 0) return { modules: [], approximated: false };
	const roots = stringList(project.modules?.roots);
	const manifests = new Map<string, ModuleManifest>();
	for (const root of roots.length > 0 ? roots : ['modules']) {
		const directory = resolve(workspaceRoot, root);
		let entries: readonly string[];
		try {
			entries = readdirSync(directory);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const manifest = readJson<ModuleManifest>(
				join(directory, entry, 'module.json'),
			);
			if (typeof manifest?.id === 'string') {
				manifests.set(manifest.id, manifest);
			}
		}
	}
	if (manifests.size === 0) {
		return {
			modules: enabled.map((moduleId) => requirements(moduleId, true)),
			approximated: true,
		};
	}
	const modules: ModuleDatabaseRequirements[] = [];
	for (const moduleId of enabled) {
		const manifest = manifests.get(moduleId);
		if (!manifest) continue;
		if (!stringList(manifest.capabilities).includes('database')) continue;
		modules.push(requirements(moduleId, manifest.tenancy === 'required'));
	}
	return { modules, approximated: false };
}
